require("dotenv").config();

const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Stripe = require("stripe");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const CURRENCY = (process.env.CURRENCY || "usd").toLowerCase();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing. Add your Supabase PostgreSQL connection string in Render Environment Variables.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'General',
      image TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL,
      supplier_cost_cents INTEGER NOT NULL DEFAULT 0,
      supplier_product_url TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      stripe_session_id TEXT UNIQUE,
      customer_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      postal_code TEXT NOT NULL,
      country TEXT NOT NULL,
      items_json TEXT NOT NULL,
      subtotal_cents INTEGER NOT NULL,
      shipping_cents INTEGER NOT NULL DEFAULT 0,
      supplier_cost_cents INTEGER NOT NULL DEFAULT 0,
      payment_fee_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'paid',
      supplier_status TEXT NOT NULL DEFAULT 'pending',
      tracking_number TEXT NOT NULL DEFAULT '',
      tracking_url TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const result = await pool.query("SELECT COUNT(*)::int AS n FROM products");
  if (result.rows[0].n === 0) {
    await pool.query(
      `INSERT INTO products
       (name, description, category, image, price_cents, supplier_cost_cents, supplier_product_url)
       VALUES
       ($1,$2,$3,$4,$5,$6,$7),
       ($8,$9,$10,$11,$12,$13,$14),
       ($15,$16,$17,$18,$19,$20,$21)`,
      [
        "Minimal Everyday Tote",
        "A versatile everyday bag. Replace this demo listing with a verified supplier product.",
        "Accessories",
        "https://images.unsplash.com/photo-1590879800638-2ea4f1a7f6c4?w=900",
        1999, 650, "",
        "Ceramic Desk Cup",
        "A simple desk accessory. Check material, dimensions, and shipping before listing.",
        "Home",
        "https://images.unsplash.com/photo-1514228742587-6b1558fcco3d?w=900",
        1499, 500, "",
        "Travel Organizer",
        "A compact organizer for travel essentials. Demo product only.",
        "Travel",
        "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=900",
        2499, 900, ""
      ]
    );
  }
}

app.use(helmet({ contentSecurityPolicy: false }));

// Stripe webhook must receive the raw request body, so register it before express.json().
app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null;

  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send("Webhook not configured");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook signature error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const checkoutSession = event.data.object;
      await pool.query(
        "UPDATE orders SET status = 'paid' WHERE stripe_session_id = $1",
        [checkoutSession.id]
      );
    }
    return res.json({ received: true });
  } catch (err) {
    console.error("Stripe webhook database error:", err);
    return res.status(500).send("Webhook processing failed");
  }
});

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));

app.use(session({
  store: new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use("/api/", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false
}));

app.use(express.static(path.join(__dirname, "public")));

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: "Please sign in as the store administrator." });
}

function cleanText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function cents(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1000000) {
    throw new Error("Invalid price");
  }
  return Math.round(number * 100);
}

app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, description, category, image, price_cents
       FROM products WHERE active = 1 ORDER BY id DESC`
    );
    return res.json(result.rows.map(product => ({
      ...product,
      price: product.price_cents / 100
    })));
  } catch (err) {
    console.error("Products error:", err);
    return res.status(500).json({ error: "Could not load products." });
  }
});

app.post("/api/checkout", async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({
        error: "Online payment is not configured yet. Add Stripe keys to your environment."
      });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const { items, customer } = req.body || {};

    if (!Array.isArray(items) || !items.length || items.length > 30) {
      return res.status(400).json({ error: "Your cart is empty or too large." });
    }

    const customerInfo = {
      name: cleanText(customer?.name, 120),
      email: cleanText(customer?.email, 160),
      phone: cleanText(customer?.phone, 40),
      address: cleanText(customer?.address, 200),
      city: cleanText(customer?.city, 100),
      postal: cleanText(customer?.postalCode, 30),
      country: cleanText(customer?.country, 80)
    };

    if (Object.values(customerInfo).some(value => !value)) {
      return res.status(400).json({ error: "Please complete all shipping and contact fields." });
    }

    const quantities = new Map();
    for (const item of items) {
      const id = Number(item.id);
      const quantity = Math.max(0, Math.min(10, Math.floor(Number(item.quantity))));
      if (!Number.isInteger(id) || quantity < 1) {
        return res.status(400).json({ error: "Invalid cart item." });
      }
      quantities.set(id, (quantities.get(id) || 0) + quantity);
    }

    const lineItems = [];
    const orderItems = [];
    let subtotal = 0;
    let supplierCost = 0;

    for (const [id, quantity] of quantities) {
      const result = await pool.query(
        "SELECT * FROM products WHERE id = $1 AND active = 1",
        [id]
      );
      const product = result.rows[0];

      if (!product) {
        return res.status(400).json({ error: "A product is no longer available." });
      }

      lineItems.push({
        quantity,
        price_data: {
          currency: CURRENCY,
          unit_amount: product.price_cents,
          product_data: {
            name: product.name,
            description: product.description.slice(0, 500)
          }
        }
      });

      subtotal += product.price_cents * quantity;
      supplierCost += product.supplier_cost_cents * quantity;
      orderItems.push({
        productId: product.id,
        name: product.name,
        quantity,
        unitPriceCents: product.price_cents
      });
    }

    const orderId = crypto.randomUUID();
    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      customer_email: customerInfo.email,
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/?checkout=cancelled`,
      metadata: { orderId },
      phone_number_collection: { enabled: false }
    });

    await pool.query(
      `INSERT INTO orders
       (id, stripe_session_id, customer_name, email, phone, address, city,
        postal_code, country, items_json, subtotal_cents, supplier_cost_cents, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        orderId, checkout.id, customerInfo.name, customerInfo.email,
        customerInfo.phone, customerInfo.address, customerInfo.city,
        customerInfo.postal, customerInfo.country, JSON.stringify(orderItems),
        subtotal, supplierCost, "awaiting_payment"
      ]
    );

    return res.json({ url: checkout.url });
  } catch (err) {
    console.error("Checkout error:", err);
    return res.status(400).json({ error: err.message || "Could not start checkout." });
  }
});

app.get("/api/admin/me", (req, res) => {
  return res.json({ signedIn: !!req.session.isAdmin });
});

app.post("/api/admin/login", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8
}), async (req, res) => {
  const username = cleanText(req.body.username, 80);
  const password = String(req.body.password || "");
  const passwordHash = process.env.ADMIN_PASSWORD_HASH || "";

  if (
    !passwordHash ||
    username !== (process.env.ADMIN_USERNAME || "admin") ||
    !(await bcrypt.compare(password, passwordHash))
  ) {
    return res.status(401).json({ error: "Invalid login. Check your administrator credentials." });
  }

  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Could not start admin session." });
    req.session.isAdmin = true;
    return res.json({ ok: true });
  });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM products ORDER BY id DESC");
    return res.json(result.rows);
  } catch (err) {
    console.error("Admin products error:", err);
    return res.status(500).json({ error: "Could not load products." });
  }
});

app.post("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const body = req.body;
    const result = await pool.query(
      `INSERT INTO products
       (name, description, category, image, price_cents, supplier_cost_cents, supplier_product_url, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        cleanText(body.name, 120),
        cleanText(body.description, 1000),
        cleanText(body.category, 80),
        cleanText(body.image, 1000),
        cents(body.price),
        cents(body.supplierCost),
        cleanText(body.supplierUrl, 1000),
        body.active === false ? 0 : 1
      ]
    );
    return res.json({ id: result.rows[0].id });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.put("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    const body = req.body;
    await pool.query(
      `UPDATE products
       SET name=$1, description=$2, category=$3, image=$4, price_cents=$5,
           supplier_cost_cents=$6, supplier_product_url=$7, active=$8
       WHERE id=$9`,
      [
        cleanText(body.name, 120),
        cleanText(body.description, 1000),
        cleanText(body.category, 80),
        cleanText(body.image, 1000),
        cents(body.price),
        cents(body.supplierCost),
        cleanText(body.supplierUrl, 1000),
        body.active === false ? 0 : 1,
        Number(req.params.id)
      ]
    );
    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.delete("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query(
      "UPDATE products SET active = 0 WHERE id = $1",
      [Number(req.params.id)]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("Delete product error:", err);
    return res.status(500).json({ error: "Could not deactivate product." });
  }
});

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM orders ORDER BY created_at DESC");
    return res.json(result.rows.map(order => {
      const estimatedProfit =
        order.subtotal_cents -
        order.supplier_cost_cents -
        order.shipping_cents -
        order.payment_fee_cents;

      return {
        ...order,
        items: JSON.parse(order.items_json),
        estimatedProfitCents: estimatedProfit
      };
    }));
  } catch (err) {
    console.error("Admin orders error:", err);
    return res.status(500).json({ error: "Could not load orders." });
  }
});

app.patch("/api/admin/orders/:id", requireAdmin, async (req, res) => {
  try {
    const status = cleanText(req.body.status, 40);
    const supplierStatus = cleanText(req.body.supplierStatus, 40);
    const tracking = cleanText(req.body.trackingNumber, 100);
    const trackingUrl = cleanText(req.body.trackingUrl, 500);
    const allowed = ["paid", "processing", "shipped", "delivered", "cancelled", "refunded"];

    if (status && !allowed.includes(status)) {
      return res.status(400).json({ error: "Invalid order status" });
    }

    await pool.query(
      `UPDATE orders
       SET status = COALESCE(NULLIF($1,''), status),
           supplier_status = COALESCE(NULLIF($2,''), supplier_status),
           tracking_number = $3,
           tracking_url = $4
       WHERE id = $5`,
      [status, supplierStatus, tracking, trackingUrl, req.params.id]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("Update order error:", err);
    return res.status(500).json({ error: "Could not update order." });
  }
});

// Public tracking exposes order status and tracking details, not the customer's address.
app.get("/api/track/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, status, tracking_number, tracking_url, created_at FROM orders WHERE id = $1",
      [req.params.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: "Order not found" });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("Tracking error:", err);
    return res.status(500).json({ error: "Could not look up this order." });
  }
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    return res.json({ ok: true, database: "connected", supplierMode: process.env.SUPPLIER_MODE || "manual" });
  } catch (err) {
    console.error("Health check database error:", err);
    return res.status(503).json({ ok: false, database: "disconnected" });
  }
});

async function start() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => {
      console.log(`Rama's Shop server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("Server startup failed:", err);
    process.exit(1);
  }
}

start();
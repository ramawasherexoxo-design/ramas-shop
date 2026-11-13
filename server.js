require("dotenv").config();
const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const Database = require("better-sqlite3");
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
const db = new Database("store.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'General', image TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL, supplier_cost_cents INTEGER NOT NULL DEFAULT 0,
  supplier_product_url TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, stripe_session_id TEXT UNIQUE,
  customer_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL,
  address TEXT NOT NULL, city TEXT NOT NULL, postal_code TEXT NOT NULL,
  country TEXT NOT NULL, items_json TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL, shipping_cents INTEGER NOT NULL DEFAULT 0,
  supplier_cost_cents INTEGER NOT NULL DEFAULT 0, payment_fee_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'paid', supplier_status TEXT NOT NULL DEFAULT 'pending',
  tracking_number TEXT NOT NULL DEFAULT '', tracking_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const seed = db.prepare("SELECT COUNT(*) AS n FROM products").get().n;
if (!seed) {
  const add = db.prepare(`INSERT INTO products
    (name, description, category, image, price_cents, supplier_cost_cents, supplier_product_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  add.run("Minimal Everyday Tote", "A versatile everyday bag. Replace this demo listing with a verified supplier product.", "Accessories", "https://images.unsplash.com/photo-1590879800638-2ea4f1a7f6c4?w=900", 1999, 650, "");
  add.run("Ceramic Desk Cup", "A simple desk accessory. Check material, dimensions, and shipping before listing.", "Home", "https://images.unsplash.com/photo-1514228742587-6b1558fcco3d?w=900", 1499, 500, "");
  add.run("Travel Organizer", "A compact organizer for travel essentials. Demo product only.", "Travel", "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=900", 2499, 900, "");
}

app.use(helmet({ contentSecurityPolicy: false }));
// Stripe webhook needs the raw body, so it is registered before express.json().
app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), (req, res) => {
  const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send("Webhook not configured");
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature error: ${err.message}`);
  }
  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    const order = db.prepare("SELECT id FROM orders WHERE stripe_session_id = ?").get(s.id);
    if (order) db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(order.id);
  }
  res.json({ received: true });
});

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  store: new SQLiteStore({ db: "sessions.sqlite", dir: "." }),
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 }
}));
app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, "public")));

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: "Please sign in as the store administrator." });
}
function cleanText(v, max = 500) {
  return String(v || "").trim().slice(0, max);
}
function cents(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1000000) throw new Error("Invalid price");
  return Math.round(n * 100);
}

app.get("/api/products", (req, res) => {
  const rows = db.prepare("SELECT id,name,description,category,image,price_cents FROM products WHERE active=1 ORDER BY id DESC").all();
  res.json(rows.map(p => ({ ...p, price: p.price_cents / 100 })));
});

app.post("/api/checkout", async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: "Online payment is not configured yet. Add Stripe keys to your environment." });
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const { items, customer } = req.body || {};
    if (!Array.isArray(items) || !items.length || items.length > 30) return res.status(400).json({ error: "Your cart is empty or too large." });
    const c = {
      name: cleanText(customer?.name, 120), email: cleanText(customer?.email, 160),
      phone: cleanText(customer?.phone, 40), address: cleanText(customer?.address, 200),
      city: cleanText(customer?.city, 100), postal: cleanText(customer?.postalCode, 30),
      country: cleanText(customer?.country, 80)
    };
    if (Object.values(c).some(v => !v)) return res.status(400).json({ error: "Please complete all shipping and contact fields." });

    const getProduct = db.prepare("SELECT * FROM products WHERE id=? AND active=1");
    const quantities = new Map();
    for (const item of items) {
      const id = Number(item.id), qty = Math.max(0, Math.min(10, Math.floor(Number(item.quantity))));
      if (!Number.isInteger(id) || qty < 1) return res.status(400).json({ error: "Invalid cart item." });
      quantities.set(id, (quantities.get(id) || 0) + qty);
    }
    const lineItems = [];
    const orderItems = [];
    let subtotal = 0, supplierCost = 0;
    for (const [id, qty] of quantities) {
      const p = getProduct.get(id);
      if (!p) return res.status(400).json({ error: "A product is no longer available." });
      lineItems.push({ quantity: qty, price_data: {
        currency: CURRENCY, unit_amount: p.price_cents,
        product_data: { name: p.name, description: p.description.slice(0, 500) }
      }});
      subtotal += p.price_cents * qty;
      supplierCost += p.supplier_cost_cents * qty;
      orderItems.push({ productId: p.id, name: p.name, quantity: qty, unitPriceCents: p.price_cents });
    }
    const orderId = crypto.randomUUID();
    // Payment is collected by Stripe. Do not mark an order paid until the webhook confirms it.
    const checkout = await stripe.checkout.sessions.create({
      mode: "payment", line_items: lineItems,
      customer_email: c.email,
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/?checkout=cancelled`,
      metadata: { orderId },
      phone_number_collection: { enabled: false }
    });
    db.prepare(`INSERT INTO orders
      (id,stripe_session_id,customer_name,email,phone,address,city,postal_code,country,items_json,subtotal_cents,supplier_cost_cents,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(orderId, checkout.id, c.name, c.email, c.phone, c.address, c.city, c.postal, c.country,
        JSON.stringify(orderItems), subtotal, supplierCost, "awaiting_payment");
    res.json({ url: checkout.url });
  } catch (e) {
    res.status(400).json({ error: e.message || "Could not start checkout." });
  }
});

app.get("/api/admin/me", (req, res) => res.json({ signedIn: !!req.session.isAdmin }));
app.post("/api/admin/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 8 }), async (req, res) => {
  const username = cleanText(req.body.username, 80);
  const password = String(req.body.password || "");
  const hash = process.env.ADMIN_PASSWORD_HASH || "";
  if (!hash || username !== (process.env.ADMIN_USERNAME || "admin") || !(await bcrypt.compare(password, hash))) {
    return res.status(401).json({ error: "Invalid login. Check your administrator credentials." });
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Could not start admin session." });
    req.session.isAdmin = true;
    res.json({ ok: true });
  });
});
app.post("/api/admin/logout", requireAdmin, (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get("/api/admin/products", requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT * FROM products ORDER BY id DESC").all());
});
app.post("/api/admin/products", requireAdmin, (req, res) => {
  try {
    const b = req.body;
    const info = db.prepare(`INSERT INTO products (name,description,category,image,price_cents,supplier_cost_cents,supplier_product_url,active)
      VALUES (?,?,?,?,?,?,?,?)`).run(cleanText(b.name,120),cleanText(b.description,1000),cleanText(b.category,80),
      cleanText(b.image,1000),cents(b.price),cents(b.supplierCost),cleanText(b.supplierUrl,1000),b.active === false ? 0 : 1);
    res.json({ id: info.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: e.message }); }
});
app.put("/api/admin/products/:id", requireAdmin, (req, res) => {
  try {
    const b=req.body;
    db.prepare(`UPDATE products SET name=?,description=?,category=?,image=?,price_cents=?,supplier_cost_cents=?,supplier_product_url=?,active=?
      WHERE id=?`).run(cleanText(b.name,120),cleanText(b.description,1000),cleanText(b.category,80),cleanText(b.image,1000),
      cents(b.price),cents(b.supplierCost),cleanText(b.supplierUrl,1000),b.active === false ? 0 : 1,Number(req.params.id));
    res.json({ ok: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/admin/products/:id", requireAdmin, (req, res) => {
  db.prepare("UPDATE products SET active=0 WHERE id=?").run(Number(req.params.id));
  res.json({ ok: true });
});

app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all();
  res.json(rows.map(o => {
    const estimatedProfit = o.subtotal_cents - o.supplier_cost_cents - o.shipping_cents - o.payment_fee_cents;
    return { ...o, items: JSON.parse(o.items_json), estimatedProfitCents: estimatedProfit };
  }));
});
app.patch("/api/admin/orders/:id", requireAdmin, (req, res) => {
  const status = cleanText(req.body.status, 40);
  const supplierStatus = cleanText(req.body.supplierStatus, 40);
  const tracking = cleanText(req.body.trackingNumber, 100);
  const trackingUrl = cleanText(req.body.trackingUrl, 500);
  const allowed = ["paid","processing","shipped","delivered","cancelled","refunded"];
  if (status && !allowed.includes(status)) return res.status(400).json({error:"Invalid order status"});
  db.prepare(`UPDATE orders SET status=COALESCE(NULLIF(?,''),status),
    supplier_status=COALESCE(NULLIF(?,''),supplier_status),tracking_number=?,tracking_url=? WHERE id=?`)
    .run(status,supplierStatus,tracking,trackingUrl,req.params.id);
  res.json({ok:true});
});

// Public tracking reveals only the order status and tracking details, never the customer's address.
app.get("/api/track/:id", (req,res) => {
  const o = db.prepare("SELECT id,status,tracking_number,tracking_url,created_at FROM orders WHERE id=?").get(req.params.id);
  if (!o) return res.status(404).json({error:"Order not found"});
  res.json(o);
});

app.get("/api/health", (req,res) => res.json({ok:true, supplierMode: process.env.SUPPLIER_MODE || "manual"}));
app.listen(PORT, () => console.log(`Store running at ${BASE_URL}`));

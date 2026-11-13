# Rama's Shop — Worldwide Dropshipping Store Starter

This is a working **starter project**, not a finished production business. It includes:
- Responsive storefront and product categories
- Shopping cart stored in the customer's browser
- Checkout form and Stripe Checkout integration scaffold
- Admin login, product creation/archive, order list and tracking updates
- Supplier-cost and estimated-margin fields
- Manual supplier-fulfilment queue (supplier API is deliberately not faked)

## 1. Requirements
Install Node.js 20 or newer. Open a terminal in this folder.

## 2. Install and run
```bash
npm install
cp .env.example .env
```
Create a strong session secret and set it in `.env`. Generate an admin password hash:
```bash
node -e "console.log(require('bcryptjs').hashSync('CHOOSE_A_LONG_UNIQUE_PASSWORD', 12))"
```
Copy the printed hash into `ADMIN_PASSWORD_HASH`. Change `ADMIN_USERNAME` too.
Then run:
```bash
npm start
```
Open `http://localhost:3000`. Admin page: `http://localhost:3000/admin.html`.

**Do not deploy with the example/default session secret or a blank admin password hash.**

## 3. Configure payments
Create a Stripe account only if Stripe supports your business country and payout setup. Put your secret key in `STRIPE_SECRET_KEY`. Set `BASE_URL` to your public HTTPS domain. Configure a Stripe webhook endpoint:
`https://YOUR-DOMAIN/api/stripe-webhook`
Subscribe to `checkout.session.completed`, then put its signing secret in `STRIPE_WEBHOOK_SECRET`.

The checkout uses Stripe-hosted payment pages, so this app does not collect or store card numbers. Before launch, test successful, failed, cancelled and refunded payments. Add proper tax, shipping and refund handling for the countries where you sell.

## 4. Supplier fulfilment / Alibaba
The app currently saves paid orders and the customer's shipping details in the admin dashboard. You must place the supplier order yourself until you have an approved, supported supplier integration.

Do not assume a normal Alibaba product page can be ordered automatically by a third-party website. Ask each supplier whether they:
- accept dropshipping and single-unit orders;
- can ship without their own promotional invoice/branding (if offered);
- provide destination-country shipping prices and delivery estimates;
- provide tracking numbers;
- support an official API or a compatible fulfilment platform.

If an official API or authorized connector is available to your account, implement it server-side in a separate supplier adapter. Keep API credentials in environment variables, never in browser JavaScript. Only send an order to a supplier after payment is confirmed. Add idempotency checks so retries cannot create duplicate supplier orders. Never automate browser scraping or bypass supplier access controls.

## 5. Before taking real orders
This starter needs production hardening:
- Use HTTPS and a persistent host/database with backups.
- Add CSRF protection, stronger admin controls (2FA recommended), audit logs and account recovery.
- Validate and sanitize every field; add consent/privacy and retention policies.
- Add shipping charges, taxes/duties, refunds, inventory sync and payment-fee reconciliation.
- Restrict admin access; never expose customer addresses in public tracking pages.
- Test all flows with test payment keys and test supplier orders first.
- Confirm local business, consumer-protection, tax, privacy and import rules.

The sample products and images are placeholders. Replace them only with products you have permission to resell and verified product photos/specifications.

## 6. Profit calculation
Current estimated margin = product subtotal − stored supplier item cost − shipping cost − payment fees.
Shipping and payment-fee values are initially zero and must be reconciled from actual invoices/processor reports. This is not net profit and excludes tax, refunds, advertising, chargebacks, duties and other overhead.

## 7. Deployment
Deploy the Node app to a host that supports Node.js and persistent storage (for example a suitable Render, Railway or VPS setup). Set every `.env` value in the host's secret/environment settings, set `NODE_ENV=production`, configure HTTPS and point your domain to the host. Do not upload `.env`, `store.db`, or session databases to a public repository.

## Notes
- Currency defaults to USD. Change `CURRENCY` only after checking the payment provider's supported currencies.
- The demo has no automatic Alibaba API connection. Supplier API availability depends on your supplier, account eligibility, and official API access.


## Rama's Shop brand and worldwide selling setup
The storefront branding has been changed to **Rama's Shop** with a colorful modern palette. The current code is still a starter template: it does not automatically make every product available in every country.

Before accepting worldwide orders:
1. Decide which countries you can actually serve with each supplier.
2. Ask suppliers for tracked shipping prices, delivery estimates, customs paperwork, return address and lost/damaged parcel procedures for each destination.
3. Configure country-specific shipping rates and block destinations that a supplier cannot serve.
4. Check payment-provider eligibility for the country where your business is legally registered, and confirm supported buyer countries and currencies.
5. Publish accurate delivery, returns, privacy, contact and duties/taxes information.
6. Test checkout, fulfilment and tracking using test transactions and sample orders before launch.

Do not advertise “worldwide shipping” as guaranteed until suppliers and payment processing are verified for the destination countries.

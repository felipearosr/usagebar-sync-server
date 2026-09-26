# Hosted plan

`src/hosted/` is the fork owner's hosted Machine Sync: a small website where someone starts a 14-day trial or subscribes to the personal plan, and gets back a server URL and an Enrollment Token to paste into UsageBar. It runs the Sync Server from this repo unchanged, with `ENROLLMENT=required`, and adds the site next to it.

Self-hosters don't need any of this. `node dist/server.js` never loads `src/hosted/`.

## What it does

| Path | |
|---|---|
| `GET /` | Plan, price, "Start 14-day trial" and "Subscribe now" |
| `GET /privacy` | What the server can and can't see (protocol §10), plus what the site stores |
| `POST /checkout` | Creates a Stripe Checkout Session and redirects to it (`303`) |
| `GET /welcome?session_id=…` | Stripe's success redirect. Issues the Enrollment Token and shows it once |
| `POST /welcome/reissue` | Replaces a token that hasn't created a group, or whose group was deleted |
| `POST /stripe/webhook` | Signed Stripe events. Moves the token's expiry to follow the subscription |
| `/v1/*` | The Sync Server (protocol v1), unchanged |

The personal plan is one Sync Group, `PLAN_MAX_MACHINES` Machines (10), and `RETENTION_DAYS` of history (400). One subscription pays for one Enrollment Token, and a token creates one group.

### Token expiry follows the subscription

The expiry is written to the token and, once the token has created a group, to that group's `expiresAt`. Every change goes through `entitlementExpiry` in `src/hosted/plan.ts`:

| Subscription | Token and group expire at |
|---|---|
| Trial (`trialing`) | The trial's end, 14 days after checkout |
| Paid (`active`) | The paid period's end, plus `RENEWAL_GRACE_DAYS` (3) so a renewal has time to settle |
| Cancelled, or set to cancel | The period end, with no grace |
| Renewal failing (`past_due`, `unpaid`) | The start of the unpaid period, plus the grace |
| Ended (`canceled`) | When it ended |
| First payment pending (`incomplete`) | No token yet |

After the expiry, the Sync Server stops writes (`403 enrollment_expired`) and keeps reads working for 30 days. Extending the expiry opens writes again, and clients see the new `expiresAt` in `limits` on their next `changes` call.

A trial asks for no card. If the customer never adds one, Stripe cancels the subscription at the trial's end, and the token ends with it.

Webhooks don't trust the event body. The site re-reads the subscription from Stripe for every relevant event (`customer.subscription.*`, `invoice.*`, `checkout.session.completed`), so events that arrive late or out of order can't set a stale expiry.

### The site never sees a sync key

The token only lets a group exist. UsageBar creates the group's root key on the Machine, derives the group ID and auth key from it, and sends the server only `SHA-256(auth key)`. Nothing on the site or the server handles the key.

The site's own data lives in `hosted.db`, next to the Sync Server's `sync.db`: Stripe customer and subscription IDs, the subscription status and expiry, and the ID of the token each subscription paid for. Token secrets are shown once and never stored; the Sync Server keeps only their SHA-256. Stripe holds the email address and payment details.

### Losing the token

The welcome page shows the token once. Reloading the page shows the subscription instead, with a "Replace my token" button while the token hasn't created a group (or its group was deleted). Replacing it revokes the old token. A replaced token whose group was deleted is expired, so it can't recreate that group.

The welcome URL contains the Checkout Session ID, and that ID is what proves the visitor paid. Anyone holding the URL can see the subscription's expiry and replace an unused token. The pages send `Referrer-Policy: no-referrer` and `Cache-Control: no-store` so the URL doesn't leak through links or caches.

## Why it lives in this repo

- It needs the Sync Server's store in-process: minting a token and moving a group's expiry are writes to `sync.db`. Running both in one process keeps that a function call instead of a second, authenticated admin API.
- One deployable: the same Docker image runs either `dist/server.js` (self-hosted) or `dist/hosted/server.js` (hosted), with one data volume.
- The hosted billing code is public next to the server it sells, so anyone can check the privacy claims against it.
- UsageBar stays neutral about servers (UsageBar ADR 0002). Nothing in the app references this site; users paste the URL and token like any self-hoster would.

It doesn't use the Stripe SDK. Three REST calls and the webhook signature check are small enough to write against `fetch` and `node:crypto` (`src/hosted/stripe.ts`), which keeps the dependency list at Hono.

## Configuration

Everything from the main [README](../README.md#configuration) applies, except that `ENROLLMENT` is always `required` and `OPERATOR` defaults to `UsageBar Hosted Sync`.

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | required | The HTTPS origin customers use, for example `https://sync.example.com`. Shown as the server URL and used for Stripe's redirect URLs. `http://` is accepted only for `localhost` |
| `STRIPE_SECRET_KEY` | required | A **test-mode** key (`sk_test_…` or `rk_test_…`). Live keys are refused unless `STRIPE_ALLOW_LIVE=true` |
| `STRIPE_WEBHOOK_SECRET` | required | The webhook endpoint's signing secret (`whsec_…`) |
| `STRIPE_PRICE_ID` | required | The recurring price for the personal plan (`price_…`) |
| `STRIPE_PORTAL_URL` | none | The customer portal's login link. Shown as "Manage subscription" |
| `STRIPE_ALLOW_LIVE` | `false` | Allow a live secret key |
| `STRIPE_API_BASE` | `https://api.stripe.com` | Only for pointing at a local mock such as `stripe-mock` |
| `PLAN_PRICE` | none | Price text shown on the landing page, for example `$3 / month` |
| `PLAN_MAX_MACHINES` | `MAX_MACHINES` (10) | Machine cap on each token |
| `TRIAL_DAYS` | `14` | Trial length |
| `RENEWAL_GRACE_DAYS` | `3` | Days added past a paid period's end |
| `HOSTED_DB_PATH` | `hosted.db` next to `sync.db` | The site's own database |

## Deploying

Nothing has been deployed yet. These are the steps for a single small VM or container host with a persistent volume. Serverless platforms without a persistent disk don't fit, because both databases are SQLite files.

1. **Stripe, in test mode.** Create a product "UsageBar Sync, personal" with one recurring price, and note its `price_…` ID. Under Settings → Billing → Customer portal, allow cancellation (at period end) and copy the portal's login link. Keep the dashboard's test-mode toggle on for every step here.
2. **Webhook.** Add an endpoint at `https://<your-domain>/stripe/webhook` with these events: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `checkout.session.completed`. Copy its signing secret.
3. **Build and run** the image with a volume for `/data`:

   ```sh
   docker build -t usagebar-sync-server .
   docker run -d --name usagebar-hosted -p 127.0.0.1:8787:8787 -v usagebar-hosted:/data \
     -e PUBLIC_URL=https://sync.example.com \
     -e STRIPE_SECRET_KEY=sk_test_... \
     -e STRIPE_WEBHOOK_SECRET=whsec_... \
     -e STRIPE_PRICE_ID=price_... \
     -e STRIPE_PORTAL_URL=https://billing.stripe.com/p/login/test_... \
     -e PLAN_PRICE='$3 / month' \
     -e TRUST_PROXY=true \
     usagebar-sync-server node dist/hosted/server.js
   ```

   Pass the secrets through your host's secret store rather than the shell history where you can.
4. **TLS.** Put a reverse proxy in front, which also sets `X-Forwarded-For` for `TRUST_PROXY`. With Caddy:

   ```
   sync.example.com {
       reverse_proxy 127.0.0.1:8787
   }
   ```

5. **Check it.** `curl https://sync.example.com/v1/info` should report `"enrollment":"required"`. Run a trial checkout with Stripe's test card flow, open the welcome page, and run `ENROLLMENT_TOKEN=<token> scripts/smoke.sh https://sync.example.com`. In the Stripe dashboard, move the test subscription forward with a test clock and check that `node dist/admin.js token list` (via `docker exec`) shows the new expiry.
6. **Back up** the `/data` volume. It holds `sync.db` and `hosted.db`.

To test webhooks locally, `stripe listen --forward-to localhost:8787/stripe/webhook` prints a signing secret to use as `STRIPE_WEBHOOK_SECRET`.

## Limits

- Nothing stops one person from starting several trials with different email addresses. Stripe Checkout doesn't know about earlier trials, and the site stores no email addresses. If abuse shows up, the options are requiring a card for the trial or checking the Stripe customer's email against earlier trials.
- A subscription can't be moved to a different group except by deleting the group and replacing the token.
- There's no email with the token. The welcome page is the only place it appears.

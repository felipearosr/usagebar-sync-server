import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { RateLimiter, type RateLimitConfig } from "../rate-limit.js";
import type { FetchHandler } from "../server.js";
import type { Billing } from "./billing.js";
import {
  existingTokenPage,
  landingPage,
  messagePage,
  privacyPage,
  tokenPage,
  type Html,
  type SiteInfo,
} from "./pages.js";
import { subscriptionIdOfEvent, verifyWebhookSignature, type StripeApi } from "./stripe.js";

export type SiteDeps = {
  billing: Billing;
  stripe: StripeApi;
  site: SiteInfo;
  priceId: string;
  webhookSecret: string;
  rateLimit: RateLimitConfig;
  clientKey: (c: Context) => string;
  clock?: () => Date;
};

/** Largest webhook body accepted. Stripe events are a few KiB. */
const MAX_WEBHOOK_BYTES = 256 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://checkout.stripe.com; " +
    "base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=31536000",
};

/** The hosted plan's website: landing and privacy pages, Stripe Checkout, the welcome page, and the webhook. */
export function createSite(deps: SiteDeps) {
  const { billing, stripe, site } = deps;
  const clock = deps.clock ?? (() => new Date());
  const app = new Hono();
  const limiter = new RateLimiter(deps.rateLimit);

  const show = (c: Context, body: Html, status: 200 | 400 | 404 | 429 | 500 | 502 = 200) => c.html(body.value, status);
  const failure = (c: Context) =>
    show(
      c,
      messagePage(site, "Something went wrong", "We couldn't reach the payment provider. Try again shortly."),
      502,
    );

  app.use("*", async (c, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
    // Webhooks come from Stripe's own addresses and are authenticated, so they skip the per-IP limit.
    if (c.req.path !== "/stripe/webhook") {
      const decision = limiter.take(deps.clientKey(c), clock().getTime());
      if (!decision.ok) {
        c.header("retry-after", String(decision.retryAfterSeconds));
        return show(c, messagePage(site, "Too many requests", "Wait a moment and try again."), 429);
      }
    }
    await next();
  });

  app.get("/", (c) => show(c, landingPage(site)));
  app.get("/privacy", (c) => show(c, privacyPage(site)));

  app.post("/checkout", async (c) => {
    const form = await c.req.parseBody();
    const trial = form.plan === "trial";
    try {
      const session = await stripe.createCheckoutSession({
        priceId: deps.priceId,
        trialDays: trial ? site.trialDays : null,
        successUrl: `${site.publicUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${site.publicUrl}/`,
      });
      return c.redirect(session.url, 303);
    } catch (error) {
      console.error("Checkout failed", error);
      return failure(c);
    }
  });

  const claimed = async (c: Context, sessionId: string, action: (id: string) => ReturnType<Billing["claim"]>) => {
    c.header("cache-control", "no-store");
    let result;
    try {
      result = await action(sessionId);
    } catch (error) {
      console.error("Claim failed", error);
      return failure(c);
    }
    switch (result.kind) {
      case "not_found":
        return show(c, messagePage(site, "Checkout not found", "This link doesn't match a completed checkout."), 404);
      case "pending":
        return show(
          c,
          messagePage(
            site,
            "Payment processing",
            "Your payment hasn't been confirmed yet. Reload this page in a minute.",
          ),
        );
      case "ended":
        return show(c, messagePage(site, "Subscription ended", "This subscription has already ended."));
      case "issued":
        return show(c, tokenPage(site, { ...result, sessionId }));
      case "existing":
        return show(c, existingTokenPage(site, { ...result, sessionId }));
    }
  };

  app.get("/welcome", (c) => claimed(c, c.req.query("session_id") ?? "", (id) => billing.claim(id)));

  app.post("/welcome/reissue", async (c) => {
    const form = await c.req.parseBody();
    const sessionId = typeof form.session_id === "string" ? form.session_id : "";
    return claimed(c, sessionId, (id) => billing.reissue(id));
  });

  app.post(
    "/stripe/webhook",
    bodyLimit({ maxSize: MAX_WEBHOOK_BYTES, onError: (c) => c.json({ error: "payload_too_large" }, 413) }),
    async (c) => {
      const payload = await c.req.text();
      const signature = c.req.header("stripe-signature") ?? "";
      if (!verifyWebhookSignature(payload, signature, deps.webhookSecret, clock())) {
        return c.json({ error: "invalid_signature" }, 400);
      }
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return c.json({ error: "invalid_json" }, 400);
      }
      const subscriptionId = subscriptionIdOfEvent(event);
      if (!subscriptionId) return c.json({ received: true, result: "ignored" });
      try {
        // Non-2xx makes Stripe retry, which is what we want when Stripe itself was unreachable.
        return c.json({ received: true, result: await billing.sync(subscriptionId) });
      } catch (error) {
        console.error("Webhook sync failed", error);
        return c.json({ error: "sync_failed" }, 500);
      }
    },
  );

  app.notFound((c) => show(c, messagePage(site, "Not found", "There's nothing at this address."), 404));
  app.onError((err, c) => {
    console.error(err);
    return show(c, messagePage(site, "Something went wrong", "Try again shortly."), 500);
  });

  return app;
}

/** Sends protocol paths (`/v1/...`, and other versions so they get `unsupported_version`) to the Sync Server. */
const PROTOCOL_PATH = /^\/v\d+(\/|$)/;

/** One handler for the whole hosted deployment: the Sync Server under `/v1`, the website everywhere else. */
export function combine(sync: FetchHandler, site: FetchHandler): FetchHandler {
  return (request, env) => (PROTOCOL_PATH.test(new URL(request.url).pathname) ? sync : site)(request, env);
}

import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { loadHostedConfig, type HostedConfig } from "../../src/hosted/config.js";
import { createHostedHandler } from "../../src/hosted/server.js";
import { HostedStore } from "../../src/hosted/store.js";
import { signWebhookPayload } from "../../src/hosted/stripe.js";
import type { FetchHandler } from "../../src/server.js";
import { SqliteStore } from "../../src/store.js";
import { DAY, FakeStripe } from "./fake-stripe.js";

const WEBHOOK_SECRET = "whsec_test_hosted";
const ORIGIN = "https://sync.example.com";
const start = Date.parse("2026-09-23T14:05:12Z");
const startSeconds = start / 1000;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

const config: HostedConfig = loadHostedConfig({
  DB_PATH: ":memory:",
  PUBLIC_URL: ORIGIN,
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_ID: "price_test_personal",
  STRIPE_PORTAL_URL: "https://billing.stripe.com/p/login/test_123",
  PLAN_PRICE: "$3 / month",
  RATE_LIMIT_PER_MINUTE: "0",
});

let now: number;
let stripe: FakeStripe;
let syncStore: SqliteStore;
let hostedStore: HostedStore;
let handler: FetchHandler;

beforeEach(() => {
  now = start;
  stripe = new FakeStripe();
  syncStore = new SqliteStore(":memory:");
  hostedStore = new HostedStore(":memory:");
  const clock = () => new Date(now);
  const sync = createApp({ store: syncStore, config: config.server, clock });
  handler = createHostedHandler(config, {
    sync: (request, env) => sync.fetch(request, env as object),
    syncStore,
    hostedStore,
    stripe,
    clock,
  });
});

const request = (path: string, init?: RequestInit) => Promise.resolve(handler(new Request(`${ORIGIN}${path}`, init)));
const post = (path: string, form: Record<string, string>) =>
  request(path, { method: "POST", body: new URLSearchParams(form), redirect: "manual" });

/** Pulls the token out of the welcome page. */
function tokenFrom(page: string): string {
  const match = /<code class="secret">([A-Za-z0-9_-]{43})<\/code>/.exec(page);
  if (!match) throw new Error("no token on the page");
  return match[1]!;
}

async function webhook(event: unknown, signedAt = new Date(now)) {
  const payload = JSON.stringify(event);
  return request("/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": signWebhookPayload(payload, WEBHOOK_SECRET, signedAt) },
    body: payload,
  });
}

const subscriptionEvent = (id: string) => ({
  id: "evt_1",
  type: "customer.subscription.updated",
  data: { object: { id } },
});

/** Plays the app's `codexbar sync create`: creates a group with the token on the Sync Server. */
async function createGroup(token: string) {
  const authKey = randomBytes(32);
  const groupId = randomBytes(16).toString("base64url");
  const response = await request("/v1/groups", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Enrollment ${token}` },
    body: JSON.stringify({ groupId, authKeyHash: createHash("sha256").update(authKey).digest("base64url") }),
  });
  return { response, groupId, bearer: `Bearer ${authKey.toString("base64url")}` };
}

async function pushBlob(groupId: string, bearer: string) {
  const machineId = randomBytes(16).toString("base64url");
  return request(`/v1/groups/${groupId}/machines/${machineId}/blobs/profile`, {
    method: "PUT",
    headers: { authorization: bearer },
    body: new Uint8Array([1, 2, 3]),
  });
}

async function groupLimits(groupId: string, bearer: string) {
  const response = await request(`/v1/groups/${groupId}/changes`, { headers: { authorization: bearer } });
  return ((await response.json()) as { limits: { expiresAt: string | null; maxMachines: number } }).limits;
}

function startTrial(sessionId = "cs_test_trial") {
  const trialEnd = startSeconds + 14 * DAY;
  stripe.complete(sessionId, {
    id: "sub_trial",
    status: "trialing",
    trialEnd,
    currentPeriodStart: startSeconds,
    currentPeriodEnd: trialEnd,
  });
  return trialEnd;
}

describe("site pages", () => {
  it("serves the landing page with both plans and the privacy page", async () => {
    const landing = await request("/");
    expect(landing.status).toBe(200);
    expect(landing.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await landing.text();
    expect(html).toContain("Start 14-day trial");
    expect(html).toContain("Subscribe now");
    expect(html).toContain("Up to 10 Machines");
    expect(html).toContain("400 days of history");
    expect(html).toContain("$3 / month");

    const privacy = await (await request("/privacy")).text();
    expect(privacy).toContain("which UTC days each Machine had Spend");
    expect(privacy).toContain("the link between a paying customer and a group ID");
    expect(privacy).toContain("Spend amounts, tokens, providers, models, Machine names, or platforms.");
    expect(privacy).toContain("Anyone holding your Pairing Link can read and write all of your group");
  });

  it("returns an HTML 404 for unknown pages and leaves /v1 to the Sync Server", async () => {
    expect((await request("/nope")).status).toBe(404);
    const info = await (await request("/v1/info")).json();
    expect(info).toMatchObject({ enrollment: "required", retentionDays: 400, operator: "UsageBar Hosted Sync" });
    const v2 = await request("/v2/info");
    expect(await v2.json()).toMatchObject({ error: { code: "unsupported_version" } });
  });
});

describe("checkout", () => {
  it("sends a trial to Stripe Checkout with the trial length", async () => {
    const response = await post("/checkout", { plan: "trial" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://checkout.stripe.com/c/pay/cs_test_1");
    expect(stripe.checkouts).toEqual([
      {
        priceId: "price_test_personal",
        trialDays: 14,
        successUrl: `${ORIGIN}/welcome?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${ORIGIN}/`,
      },
    ]);
  });

  it("sends a subscription to Stripe Checkout without a trial", async () => {
    await post("/checkout", { plan: "subscribe" });
    expect(stripe.checkouts[0]).toMatchObject({ trialDays: null });
  });

  it("shows an error page when Stripe is unreachable", async () => {
    stripe.failing = true;
    expect((await post("/checkout", { plan: "trial" })).status).toBe(502);
  });
});

describe("trial → subscription → cancellation", () => {
  it("issues a token expiring with the trial, extends it on subscribing, and ends it at the period end on cancel", async () => {
    const trialEnd = startTrial();
    const welcome = await request("/welcome?session_id=cs_test_trial");
    expect(welcome.status).toBe(200);
    expect(welcome.headers.get("cache-control")).toBe("no-store");
    const page = await welcome.text();
    expect(page).toContain(ORIGIN);
    const token = tokenFrom(page);

    // The site stores the token's hash and Stripe IDs, never the token itself.
    const [stored] = syncStore.listEnrollmentTokens();
    expect(stored).toMatchObject({ maxMachines: 10, expiresAt: iso(trialEnd), groupId: null });
    expect(JSON.stringify(hostedStore.get("sub_trial"))).not.toContain(token);

    // The app creates its group with the token. The trial's 14 days become the group's expiry.
    const { response, groupId, bearer } = await createGroup(token);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      limits: { maxMachines: 10, retentionDays: 400, expiresAt: iso(trialEnd) },
    });

    // Subscribing: the trial converts, Stripe sends a webhook, and the expiry moves to the paid period's end.
    const periodEnd = trialEnd + 30 * DAY;
    stripe.update("sub_trial", {
      status: "active",
      trialEnd,
      currentPeriodStart: trialEnd,
      currentPeriodEnd: periodEnd,
    });
    const hook = await webhook(subscriptionEvent("sub_trial"));
    expect(await hook.json()).toEqual({ received: true, result: "updated" });
    expect((await groupLimits(groupId, bearer)).expiresAt).toBe(iso(periodEnd + 3 * DAY));

    // Past the trial's end, writes still work because the subscription extended the group.
    now = (trialEnd + DAY) * 1000;
    expect((await pushBlob(groupId, bearer)).status).toBe(200);

    // Cancelling in the portal: the expiry becomes the end of the paid period, with no grace.
    stripe.update("sub_trial", { cancelAtPeriodEnd: true });
    await webhook(subscriptionEvent("sub_trial"));
    expect((await groupLimits(groupId, bearer)).expiresAt).toBe(iso(periodEnd));
    expect(hostedStore.get("sub_trial")).toMatchObject({ status: "active", expiresAt: iso(periodEnd) });

    // After the period ends, writes stop and reads keep working.
    now = (periodEnd + 1) * 1000;
    expect((await pushBlob(groupId, bearer)).status).toBe(403);
    expect((await groupLimits(groupId, bearer)).expiresAt).toBe(iso(periodEnd));
  });

  it("stops writes when the trial ends without a card", async () => {
    const trialEnd = startTrial();
    const token = tokenFrom(await (await request("/welcome?session_id=cs_test_trial")).text());
    const { groupId, bearer } = await createGroup(token);

    stripe.update("sub_trial", { status: "canceled", endedAt: trialEnd });
    await webhook({ id: "evt_2", type: "customer.subscription.deleted", data: { object: { id: "sub_trial" } } });
    now = (trialEnd + 1) * 1000;
    const push = await pushBlob(groupId, bearer);
    expect(push.status).toBe(403);
    expect(await push.json()).toMatchObject({ error: { code: "enrollment_expired" } });
  });

  it("follows an immediate cancellation to the moment it ended", async () => {
    startTrial();
    await request("/welcome?session_id=cs_test_trial");
    const endedAt = startSeconds + 2 * DAY;
    stripe.update("sub_trial", { status: "canceled", endedAt });
    await webhook(subscriptionEvent("sub_trial"));
    expect(syncStore.listEnrollmentTokens()[0]!.expiresAt).toBe(iso(endedAt));
  });

  it("issues a paid subscription's token until the period end plus grace", async () => {
    const periodEnd = startSeconds + 30 * DAY;
    stripe.complete("cs_test_paid", {
      id: "sub_paid",
      status: "active",
      currentPeriodStart: startSeconds,
      currentPeriodEnd: periodEnd,
    });
    const page = await (await request("/welcome?session_id=cs_test_paid")).text();
    tokenFrom(page);
    expect(syncStore.listEnrollmentTokens()[0]!.expiresAt).toBe(iso(periodEnd + 3 * DAY));
  });
});

describe("welcome page", () => {
  it("shows the token once, then offers to replace it while it is unused", async () => {
    startTrial();
    const first = tokenFrom(await (await request("/welcome?session_id=cs_test_trial")).text());

    const again = await (await request("/welcome?session_id=cs_test_trial")).text();
    expect(again).not.toContain(first);
    expect(again).toContain("Replace my token");

    const replaced = await post("/welcome/reissue", { session_id: "cs_test_trial" });
    const second = tokenFrom(await replaced.text());
    expect(second).not.toBe(first);

    expect((await createGroup(first)).response.status).toBe(403);
    expect((await createGroup(second)).response.status).toBe(201);
    expect(syncStore.listEnrollmentTokens()).toHaveLength(1);
  });

  it("offers no replacement once the token has created a group", async () => {
    startTrial();
    const token = tokenFrom(await (await request("/welcome?session_id=cs_test_trial")).text());
    await createGroup(token);

    const page = await (await request("/welcome?session_id=cs_test_trial")).text();
    expect(page).toContain("already created your Sync Group");
    expect(page).not.toContain("Replace my token");
    const reissue = await (await post("/welcome/reissue", { session_id: "cs_test_trial" })).text();
    expect(reissue).not.toMatch(/<code class="secret">/);
  });

  it("replaces the token after its group is deleted, and the old token can't recreate that group", async () => {
    startTrial();
    const token = tokenFrom(await (await request("/welcome?session_id=cs_test_trial")).text());
    const { groupId, bearer } = await createGroup(token);
    expect(
      (await request(`/v1/groups/${groupId}`, { method: "DELETE", headers: { authorization: bearer } })).status,
    ).toBe(204);

    const page = await (await request("/welcome?session_id=cs_test_trial")).text();
    expect(page).toContain("Replace my token");
    const next = tokenFrom(await (await post("/welcome/reissue", { session_id: "cs_test_trial" })).text());
    expect((await createGroup(next)).response.status).toBe(201);

    const recreate = await request("/v1/groups", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Enrollment ${token}` },
      body: JSON.stringify({ groupId, authKeyHash: createHash("sha256").update(randomBytes(32)).digest("base64url") }),
    });
    expect(await recreate.json()).toMatchObject({ error: { code: "enrollment_expired" } });

    // Webhooks now move the new token's expiry.
    const renewed = startSeconds + 60 * DAY;
    stripe.update("sub_trial", { status: "active", currentPeriodStart: startSeconds, currentPeriodEnd: renewed });
    await webhook(subscriptionEvent("sub_trial"));
    const tokens = syncStore.listEnrollmentTokens();
    expect(tokens.find((t) => t.tokenId === hostedStore.get("sub_trial")!.tokenId)!.expiresAt).toBe(
      iso(renewed + 3 * DAY),
    );
    expect(tokens.find((t) => t.tokenId !== hostedStore.get("sub_trial")!.tokenId)!.expiresAt).toBe(iso(startSeconds));
  });

  it("rejects unknown and malformed session IDs without calling Stripe for malformed ones", async () => {
    expect((await request("/welcome?session_id=cs_test_unknown")).status).toBe(404);
    const calls = stripe.calls;
    expect((await request("/welcome?session_id=../../v1/info")).status).toBe(404);
    expect((await request("/welcome")).status).toBe(404);
    expect(stripe.calls).toBe(calls);
  });

  it("asks to wait while Checkout or the first payment is still in progress", async () => {
    stripe.complete("cs_test_open", { id: "sub_open", status: "trialing", trialEnd: startSeconds + 14 * DAY });
    stripe.sessions.set("cs_test_open", { id: "cs_test_open", status: "open", subscriptionId: "sub_open" });
    expect(await (await request("/welcome?session_id=cs_test_open")).text()).toContain("Payment processing");

    stripe.complete("cs_test_incomplete", {
      id: "sub_incomplete",
      status: "incomplete",
      currentPeriodEnd: startSeconds + DAY,
    });
    expect(await (await request("/welcome?session_id=cs_test_incomplete")).text()).toContain("Payment processing");
    expect(syncStore.listEnrollmentTokens()).toHaveLength(0);
  });

  it("issues nothing for a subscription that already ended", async () => {
    stripe.complete("cs_test_old", { id: "sub_old", status: "canceled", endedAt: startSeconds - DAY });
    expect(await (await request("/welcome?session_id=cs_test_old")).text()).toContain("Subscription ended");
    expect(syncStore.listEnrollmentTokens()).toHaveLength(0);
  });
});

describe("webhook", () => {
  it("rejects bad signatures and stale timestamps", async () => {
    const payload = JSON.stringify(subscriptionEvent("sub_trial"));
    const unsigned = await request("/stripe/webhook", { method: "POST", body: payload });
    expect(unsigned.status).toBe(400);
    const stale = await webhook(subscriptionEvent("sub_trial"), new Date(now - 10 * 60_000));
    expect(stale.status).toBe(400);
  });

  it("ignores events for unknown subscriptions and unrelated types", async () => {
    expect(await (await webhook(subscriptionEvent("sub_unknown"))).json()).toEqual({
      received: true,
      result: "ignored",
    });
    expect(await (await webhook({ type: "charge.succeeded", data: { object: {} } })).json()).toEqual({
      received: true,
      result: "ignored",
    });
    expect(stripe.calls).toBe(0);
  });

  it("returns 500 so Stripe retries when Stripe can't be reached", async () => {
    startTrial();
    await request("/welcome?session_id=cs_test_trial");
    stripe.failing = true;
    expect((await webhook(subscriptionEvent("sub_trial"))).status).toBe(500);
  });
});

describe("hosted config", () => {
  const base = {
    PUBLIC_URL: ORIGIN,
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_WEBHOOK_SECRET: "whsec_x",
    STRIPE_PRICE_ID: "price_x",
  };

  it("requires enrollment and uses the plan defaults", () => {
    const loaded = loadHostedConfig({ ...base, ENROLLMENT: "none", DATA_DIR: "/data" });
    expect(loaded.server.enrollment).toBe("required");
    expect(loaded.hostedDbPath).toBe("/data/hosted.db");
    expect(loaded.plan).toEqual({ maxMachines: 10, trialDays: 14, graceDays: 3, priceLabel: null });
  });

  it("refuses live Stripe keys unless explicitly allowed", () => {
    expect(() => loadHostedConfig({ ...base, STRIPE_SECRET_KEY: "sk_live_x" })).toThrow(/test-mode key/);
    expect(
      loadHostedConfig({ ...base, STRIPE_SECRET_KEY: "sk_live_x", STRIPE_ALLOW_LIVE: "true" }).stripe.secretKey,
    ).toBe("sk_live_x");
  });

  it("requires an HTTPS origin, except for localhost", () => {
    expect(() => loadHostedConfig({ ...base, PUBLIC_URL: "http://sync.example.com" })).toThrow(/https/);
    expect(() => loadHostedConfig({ ...base, PUBLIC_URL: "https://sync.example.com/app" })).toThrow(/no path/);
    expect(loadHostedConfig({ ...base, PUBLIC_URL: "http://localhost:8787" }).publicUrl).toBe("http://localhost:8787");
    expect(loadHostedConfig({ ...base, PUBLIC_URL: "https://sync.example.com/" }).publicUrl).toBe(ORIGIN);
  });

  it("names each missing setting", () => {
    expect(() => loadHostedConfig({ ...base, STRIPE_PRICE_ID: "" })).toThrow(/STRIPE_PRICE_ID/);
    expect(() => loadHostedConfig({ ...base, PUBLIC_URL: undefined })).toThrow(/PUBLIC_URL/);
  });
});

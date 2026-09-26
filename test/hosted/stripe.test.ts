import { describe, expect, it } from "vitest";
import {
  StripeClient,
  StripeError,
  formEncode,
  parseSubscription,
  signWebhookPayload,
  subscriptionIdOfEvent,
  verifyWebhookSignature,
} from "../../src/hosted/stripe.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("StripeClient", () => {
  it("creates a trial Checkout Session that needs no card", async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: { id: "cs_test_1", url: "https://checkout.stripe.com/x" } }]);
    const client = new StripeClient("sk_test_abc", fn);
    const session = await client.createCheckoutSession({
      priceId: "price_1",
      trialDays: 14,
      successUrl: "https://sync.example.com/welcome?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://sync.example.com/",
    });
    expect(session).toEqual({ id: "cs_test_1", url: "https://checkout.stripe.com/x" });

    const [call] = calls;
    expect(call!.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(call!.init.method).toBe("POST");
    expect((call!.init.headers as Record<string, string>).authorization).toBe("Bearer sk_test_abc");
    const form = Object.fromEntries(new URLSearchParams(call!.init.body as string));
    expect(form).toEqual({
      mode: "subscription",
      "line_items[0][price]": "price_1",
      "line_items[0][quantity]": "1",
      success_url: "https://sync.example.com/welcome?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://sync.example.com/",
      payment_method_collection: "if_required",
      "subscription_data[trial_period_days]": "14",
      "subscription_data[trial_settings][end_behavior][missing_payment_method]": "cancel",
    });
  });

  it("creates a paid Checkout Session without trial settings", async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: { id: "cs_test_2", url: "https://checkout.stripe.com/y" } }]);
    await new StripeClient("sk_test_abc", fn).createCheckoutSession({
      priceId: "price_1",
      trialDays: null,
      successUrl: "https://a/welcome",
      cancelUrl: "https://a/",
    });
    const form = new URLSearchParams(calls[0]!.init.body as string);
    expect([...form.keys()]).toEqual([
      "mode",
      "line_items[0][price]",
      "line_items[0][quantity]",
      "success_url",
      "cancel_url",
    ]);
  });

  it("returns undefined for an unknown Checkout Session and throws on other errors", async () => {
    const { fn } = fakeFetch([
      { status: 404, body: { error: { message: "No such checkout.session" } } },
      { status: 401, body: { error: { message: "Invalid API Key" } } },
    ]);
    const client = new StripeClient("sk_test_abc", fn);
    expect(await client.getCheckoutSession("cs_test_missing")).toBeUndefined();
    await expect(client.getCheckoutSession("cs_test_x")).rejects.toThrow(new StripeError(401, "Invalid API Key"));
  });

  it("reads a Checkout Session's subscription whether or not it is expanded", async () => {
    const { fn } = fakeFetch([
      { status: 200, body: { id: "cs_test_1", status: "complete", subscription: "sub_1" } },
      { status: 200, body: { id: "cs_test_2", status: "open", subscription: { id: "sub_2" } } },
    ]);
    const client = new StripeClient("sk_test_abc", fn);
    expect(await client.getCheckoutSession("cs_test_1")).toEqual({
      id: "cs_test_1",
      status: "complete",
      subscriptionId: "sub_1",
    });
    expect(await client.getCheckoutSession("cs_test_2")).toEqual({
      id: "cs_test_2",
      status: "open",
      subscriptionId: "sub_2",
    });
  });
});

describe("parseSubscription", () => {
  it("reads the billing period from the subscription (older API versions)", () => {
    expect(
      parseSubscription({
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        current_period_start: 100,
        current_period_end: 200,
        cancel_at_period_end: true,
        cancel_at: null,
        ended_at: null,
        trial_end: null,
      }),
    ).toEqual({
      id: "sub_1",
      customerId: "cus_1",
      status: "active",
      trialEnd: null,
      currentPeriodStart: 100,
      currentPeriodEnd: 200,
      cancelAtPeriodEnd: true,
      cancelAt: null,
      endedAt: null,
    });
  });

  it("reads the billing period from the first item (2025-03-31 and later)", () => {
    const sub = parseSubscription({
      id: "sub_1",
      customer: { id: "cus_1" },
      status: "trialing",
      trial_end: 300,
      items: { data: [{ current_period_start: 100, current_period_end: 300 }] },
    });
    expect(sub).toMatchObject({ customerId: "cus_1", trialEnd: 300, currentPeriodStart: 100, currentPeriodEnd: 300 });
  });
});

describe("formEncode", () => {
  it("flattens nested objects and skips empty values", () => {
    expect(formEncode({ a: 1, b: { c: "x", d: { 0: true } }, e: undefined, f: null }).toString()).toBe(
      "a=1&b%5Bc%5D=x&b%5Bd%5D%5B0%5D=true",
    );
  });
});

describe("webhook signatures", () => {
  const secret = "whsec_test_secret";
  const now = new Date("2026-09-23T14:05:12Z");
  const payload = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated" });

  it("accepts a correctly signed payload", () => {
    expect(verifyWebhookSignature(payload, signWebhookPayload(payload, secret, now), secret, now)).toBe(true);
  });

  it("accepts a header with several signatures when one matches", () => {
    const header = signWebhookPayload(payload, secret, now).replace("v1=", `v1=${"0".repeat(64)},v1=`);
    expect(verifyWebhookSignature(payload, header, secret, now)).toBe(true);
  });

  it("rejects a changed body, a wrong secret, and a malformed header", () => {
    const header = signWebhookPayload(payload, secret, now);
    expect(verifyWebhookSignature(`${payload} `, header, secret, now)).toBe(false);
    expect(verifyWebhookSignature(payload, header, "whsec_other", now)).toBe(false);
    expect(verifyWebhookSignature(payload, "", secret, now)).toBe(false);
    expect(verifyWebhookSignature(payload, "t=abc,v1=zz", secret, now)).toBe(false);
  });

  it("rejects a signature older than five minutes", () => {
    const header = signWebhookPayload(payload, secret, new Date(now.getTime() - 301_000));
    expect(verifyWebhookSignature(payload, header, secret, now)).toBe(false);
  });
});

describe("subscriptionIdOfEvent", () => {
  it("finds the subscription in subscription, invoice and checkout events", () => {
    const event = (type: string, object: unknown) => ({ type, data: { object } });
    expect(subscriptionIdOfEvent(event("customer.subscription.deleted", { id: "sub_1" }))).toBe("sub_1");
    expect(subscriptionIdOfEvent(event("invoice.paid", { subscription: "sub_2" }))).toBe("sub_2");
    expect(
      subscriptionIdOfEvent(event("invoice.paid", { parent: { subscription_details: { subscription: "sub_3" } } })),
    ).toBe("sub_3");
    expect(subscriptionIdOfEvent(event("checkout.session.completed", { subscription: "sub_4" }))).toBe("sub_4");
    expect(subscriptionIdOfEvent(event("charge.succeeded", { id: "ch_1" }))).toBeNull();
  });
});

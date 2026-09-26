import { createHmac, timingSafeEqual } from "node:crypto";

/** The parts of a Stripe Subscription the hosted plan reads. Times are Unix seconds. */
export type Subscription = {
  id: string;
  customerId: string | null;
  /** `trialing`, `active`, `past_due`, `unpaid`, `canceled`, `incomplete`, `incomplete_expired` or `paused`. */
  status: string;
  trialEnd: number | null;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: number | null;
  endedAt: number | null;
};

export type CheckoutSession = {
  id: string;
  /** `open`, `complete` or `expired`. */
  status: string | null;
  subscriptionId: string | null;
};

export type CreateCheckoutInput = {
  priceId: string;
  /** Days of free trial. When set, Checkout doesn't ask for a card. */
  trialDays: number | null;
  successUrl: string;
  cancelUrl: string;
};

/** The Stripe calls the hosted plan makes. Tests pass a fake. */
export interface StripeApi {
  createCheckoutSession(input: CreateCheckoutInput): Promise<{ id: string; url: string }>;
  /** `undefined` when Stripe doesn't know the ID. */
  getCheckoutSession(id: string): Promise<CheckoutSession | undefined>;
  getSubscription(id: string): Promise<Subscription>;
}

export class StripeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
/** An expandable field is either an ID or an object with one. */
const idOf = (value: unknown): string | null => str(value) ?? str((value as Json | null)?.id);

/**
 * Reads a Subscription from any recent API version. Since 2025-03-31 the billing period lives on each item instead of
 * the subscription, so both places are checked.
 */
export function parseSubscription(raw: Json): Subscription {
  const item = ((raw.items as Json | undefined)?.data as Json[] | undefined)?.[0];
  return {
    id: String(raw.id),
    customerId: idOf(raw.customer),
    status: String(raw.status),
    trialEnd: num(raw.trial_end),
    currentPeriodStart: num(raw.current_period_start) ?? num(item?.current_period_start),
    currentPeriodEnd: num(raw.current_period_end) ?? num(item?.current_period_end),
    cancelAtPeriodEnd: raw.cancel_at_period_end === true,
    cancelAt: num(raw.cancel_at),
    endedAt: num(raw.ended_at),
  };
}

/** Flattens `{ a: { b: 1 } }` into `a[b]=1`, the form encoding Stripe's API takes. */
export function formEncode(params: Json, prefix = "", into = new URLSearchParams()): URLSearchParams {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object") formEncode(value as Json, name, into);
    else into.append(name, String(value));
  }
  return into;
}

/** Talks to the Stripe REST API with `fetch`, so the server needs no Stripe SDK. */
export class StripeClient implements StripeApi {
  constructor(
    private readonly secretKey: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly baseUrl = "https://api.stripe.com",
  ) {}

  async createCheckoutSession(input: CreateCheckoutInput) {
    const trial = input.trialDays !== null;
    const session = await this.request("POST", "/v1/checkout/sessions", {
      mode: "subscription",
      line_items: { 0: { price: input.priceId, quantity: 1 } },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      // A trial asks for no card. If none was added by the trial's end, the subscription cancels itself.
      payment_method_collection: trial ? "if_required" : undefined,
      subscription_data: trial
        ? {
            trial_period_days: input.trialDays,
            trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
          }
        : undefined,
    });
    return { id: String(session.id), url: String(session.url) };
  }

  async getCheckoutSession(id: string) {
    try {
      const session = await this.request("GET", `/v1/checkout/sessions/${encodeURIComponent(id)}`);
      return { id: String(session.id), status: str(session.status), subscriptionId: idOf(session.subscription) };
    } catch (error) {
      if (error instanceof StripeError && error.status === 404) return undefined;
      throw error;
    }
  }

  async getSubscription(id: string) {
    return parseSubscription(await this.request("GET", `/v1/subscriptions/${encodeURIComponent(id)}`));
  }

  private async request(method: "GET" | "POST", path: string, params?: Json): Promise<Json> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        ...(params ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: params ? formEncode(params).toString() : undefined,
    });
    const body = (await response.json().catch(() => ({}))) as Json;
    if (!response.ok) {
      const message = str((body.error as Json | undefined)?.message) ?? `Stripe returned ${response.status}`;
      throw new StripeError(response.status, message);
    }
    return body;
  }
}

/** How far a webhook's signed timestamp may be from now, as in Stripe's own libraries. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Checks a `Stripe-Signature` header against the raw request body: an HMAC-SHA256 of `"<t>.<body>"` keyed with the
 * endpoint's signing secret, with `t` within the tolerance of `now`.
 */
export function verifyWebhookSignature(payload: string, header: string, secret: string, now: Date): boolean {
  let t: number | undefined;
  const signatures: Buffer[] = [];
  for (const part of header.split(",")) {
    const [key, value = ""] = part.trim().split("=", 2);
    if (key === "t") t = Number(value);
    if (key === "v1" && /^[0-9a-f]{64}$/.test(value)) signatures.push(Buffer.from(value, "hex"));
  }
  if (t === undefined || !Number.isInteger(t) || signatures.length === 0) return false;
  if (Math.abs(now.getTime() / 1000 - t) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest();
  return signatures.some((signature) => timingSafeEqual(signature, expected));
}

/** Builds a `Stripe-Signature` header, for tests and local tooling. */
export function signWebhookPayload(payload: string, secret: string, now: Date): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
}

/** The subscription a webhook event is about, or null for events the hosted plan ignores. */
export function subscriptionIdOfEvent(event: Json): string | null {
  const type = str(event.type) ?? "";
  const object = ((event.data as Json | undefined)?.object ?? {}) as Json;
  if (type.startsWith("customer.subscription.")) return str(object.id);
  if (type.startsWith("invoice.")) {
    const parent = (object.parent as Json | undefined)?.subscription_details as Json | undefined;
    return idOf(object.subscription) ?? idOf(parent?.subscription);
  }
  if (type === "checkout.session.completed") return idOf(object.subscription);
  return null;
}

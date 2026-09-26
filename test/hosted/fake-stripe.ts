import type { CheckoutSession, CreateCheckoutInput, StripeApi, Subscription } from "../../src/hosted/stripe.js";

export const DAY = 86_400;

/** An in-memory Stripe. Tests create sessions and change subscriptions directly. */
export class FakeStripe implements StripeApi {
  readonly sessions = new Map<string, CheckoutSession>();
  readonly subscriptions = new Map<string, Subscription>();
  readonly checkouts: CreateCheckoutInput[] = [];
  calls = 0;
  failing = false;

  async createCheckoutSession(input: CreateCheckoutInput) {
    this.guard();
    this.checkouts.push(input);
    const id = `cs_test_${this.checkouts.length}`;
    return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
  }

  async getCheckoutSession(id: string) {
    this.guard();
    return this.sessions.get(id);
  }

  async getSubscription(id: string) {
    this.guard();
    const sub = this.subscriptions.get(id);
    if (!sub) throw new Error(`no subscription ${id}`);
    return { ...sub };
  }

  /** A completed Checkout Session for a new subscription. */
  complete(sessionId: string, sub: Partial<Subscription> & { id: string }) {
    this.subscriptions.set(sub.id, subscription(sub));
    this.sessions.set(sessionId, { id: sessionId, status: "complete", subscriptionId: sub.id });
  }

  update(id: string, changes: Partial<Subscription>) {
    this.subscriptions.set(id, { ...this.subscriptions.get(id)!, ...changes });
  }

  private guard() {
    this.calls += 1;
    if (this.failing) throw new Error("Stripe is down");
  }
}

export function subscription(fields: Partial<Subscription> & { id: string }): Subscription {
  return {
    customerId: "cus_test_1",
    status: "active",
    trialEnd: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    cancelAt: null,
    endedAt: null,
    ...fields,
  };
}

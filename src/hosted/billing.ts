import { mintEnrollmentToken, timestamp } from "../enrollment.js";
import type { SqliteStore } from "../store.js";
import { entitlementExpiry } from "./plan.js";
import type { SubscriptionRecord, HostedStore } from "./store.js";
import type { StripeApi, Subscription } from "./stripe.js";

export type PlanConfig = {
  maxMachines: number;
  /** Days added past a paid period's end, so renewals have time to settle. */
  graceDays: number;
};

/** What the welcome page shows for a Checkout Session. */
export type ClaimResult =
  /** Not a completed Checkout Session for a subscription. */
  | { kind: "not_found" }
  /** Checkout finished but the first payment hasn't settled yet. */
  | { kind: "pending" }
  /** The subscription ended before a token was issued. */
  | { kind: "ended" }
  /** A new token. Its secret is shown this once. */
  | { kind: "issued"; token: string; expiresAt: string; replaced: boolean }
  /**
   * A token was issued earlier. `canReissue` is true while that token hasn't created a group, or its group was
   * deleted, and the subscription is still running.
   */
  | { kind: "existing"; expiresAt: string; inUse: boolean; canReissue: boolean };

export type SyncResult = "updated" | "ignored";

export type BillingDeps = {
  stripe: StripeApi;
  syncStore: SqliteStore;
  hostedStore: HostedStore;
  plan: PlanConfig;
  clock?: () => Date;
};

const CHECKOUT_SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{1,200}$/;

/**
 * Turns Stripe subscriptions into Enrollment Tokens. One subscription pays for one token, and so for one Sync Group.
 * The token's expiry, and its group's, follow the subscription (see `entitlementExpiry`).
 *
 * The Checkout Session ID in the welcome URL is what proves the visitor paid. Anyone holding that URL can see the
 * status and, while the token is unused, replace it; the URL is only ever shown to the customer by Stripe's redirect.
 */
export class Billing {
  private readonly clock: () => Date;

  constructor(private readonly deps: BillingDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /** Handles the redirect back from Checkout: issues the token the first time, reports its state afterwards. */
  async claim(sessionId: string): Promise<ClaimResult> {
    const sub = await this.subscriptionForSession(sessionId);
    if (sub === "not_found" || sub === "pending") return { kind: sub };

    // Everything below is synchronous, so two requests for the same session can't both issue a token.
    const expiresAt = this.expiryOf(sub);
    if (expiresAt === undefined) return { kind: "pending" };
    const record = this.deps.hostedStore.get(sub.id);
    if (!record) {
      if (!this.isRunning(expiresAt)) return { kind: "ended" };
      const token = this.mint(sub, expiresAt);
      const now = timestamp(this.clock());
      this.deps.hostedStore.insert({
        subscriptionId: sub.id,
        customerId: sub.customerId,
        tokenId: token.tokenId,
        status: sub.status,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });
      return { kind: "issued", token: token.secret, expiresAt, replaced: false };
    }
    this.apply(record, sub, expiresAt, record.tokenId);
    return this.describe(record.tokenId, expiresAt);
  }

  /** Replaces a token that hasn't created a group, or whose group was deleted. The old one stops working. */
  async reissue(sessionId: string): Promise<ClaimResult> {
    const sub = await this.subscriptionForSession(sessionId);
    if (sub === "not_found" || sub === "pending") return { kind: sub };
    const expiresAt = this.expiryOf(sub);
    const record = this.deps.hostedStore.get(sub.id);
    if (expiresAt === undefined || !record) return { kind: "pending" };

    const current = this.describe(record.tokenId, expiresAt);
    if (current.kind !== "existing" || !current.canReissue) {
      this.apply(record, sub, expiresAt, record.tokenId);
      return current;
    }
    const old = this.deps.syncStore.getEnrollmentToken(record.tokenId);
    if (old?.groupId === null) {
      this.deps.syncStore.revokeEnrollmentToken(old.tokenId);
    } else if (old) {
      // Bound to a deleted group. Expire it so it can't recreate that group next to the new one.
      this.deps.syncStore.setEnrollmentTokenExpiry(old.tokenId, timestamp(this.clock()));
    }
    const token = this.mint(sub, expiresAt);
    this.apply(record, sub, expiresAt, token.tokenId);
    return { kind: "issued", token: token.secret, expiresAt, replaced: true };
  }

  /** Handles a webhook: re-reads the subscription from Stripe and moves the token's expiry to match. */
  async sync(subscriptionId: string): Promise<SyncResult> {
    if (!this.deps.hostedStore.get(subscriptionId)) return "ignored";
    const sub = await this.deps.stripe.getSubscription(subscriptionId);
    // Read again after the await, in case a reissue changed the token meanwhile.
    const record = this.deps.hostedStore.get(subscriptionId);
    const expiresAt = this.expiryOf(sub);
    if (!record || expiresAt === undefined) return "ignored";
    this.apply(record, sub, expiresAt, record.tokenId);
    return "updated";
  }

  private async subscriptionForSession(sessionId: string): Promise<Subscription | "not_found" | "pending"> {
    if (!CHECKOUT_SESSION_ID.test(sessionId)) return "not_found";
    const session = await this.deps.stripe.getCheckoutSession(sessionId);
    if (!session?.subscriptionId) return "not_found";
    if (session.status !== "complete") return "pending";
    return this.deps.stripe.getSubscription(session.subscriptionId);
  }

  /** RFC 3339 expiry, or `undefined` while the subscription grants nothing. */
  private expiryOf(sub: Subscription): string | undefined {
    const seconds = entitlementExpiry(sub, this.deps.plan.graceDays);
    return seconds === null ? undefined : timestamp(new Date(seconds * 1000));
  }

  private isRunning(expiresAt: string) {
    return Date.parse(expiresAt) > this.clock().getTime();
  }

  private mint(sub: Subscription, expiresAt: string) {
    const { secret, token } = mintEnrollmentToken(this.deps.syncStore, {
      maxMachines: this.deps.plan.maxMachines,
      expiresAt,
      note: `stripe ${sub.id}`,
      now: this.clock(),
    });
    return { secret, tokenId: token.tokenId };
  }

  private apply(record: SubscriptionRecord, sub: Subscription, expiresAt: string, tokenId: string) {
    this.deps.syncStore.setEnrollmentTokenExpiry(tokenId, expiresAt);
    this.deps.hostedStore.update(record.subscriptionId, {
      tokenId,
      status: sub.status,
      expiresAt,
      updatedAt: timestamp(this.clock()),
    });
  }

  private describe(tokenId: string, expiresAt: string): ClaimResult {
    const token = this.deps.syncStore.getEnrollmentToken(tokenId);
    const inUse = token?.groupId != null && this.deps.syncStore.getGroup(token.groupId) !== undefined;
    return { kind: "existing", expiresAt, inUse, canReissue: !inUse && this.isRunning(expiresAt) };
  }
}

import type { Subscription } from "./stripe.js";

const DAY_SECONDS = 86_400;

/**
 * When a subscription's Enrollment Token (and the Sync Group it created) should expire, as Unix seconds. `null` means
 * the subscription grants nothing yet (its first payment hasn't gone through), so no token should be issued.
 *
 * - A trial runs to its end.
 * - A paid subscription runs to the end of the paid period, plus `graceDays` so a renewal that takes a moment to
 *   settle doesn't stop writes.
 * - A cancelled subscription, or one set to cancel, runs to its period end with no grace.
 * - A failed renewal keeps what was paid for, plus the grace, while Stripe retries the payment.
 */
export function entitlementExpiry(sub: Subscription, graceDays: number): number | null {
  const grace = graceDays * DAY_SECONDS;
  const scheduledEnd = sub.cancelAt ?? (sub.cancelAtPeriodEnd ? sub.currentPeriodEnd : null);
  const capped = (end: number | null) => (end === null || scheduledEnd === null ? end : Math.min(end, scheduledEnd));

  switch (sub.status) {
    case "trialing":
      return capped(sub.trialEnd ?? sub.currentPeriodEnd);
    case "active":
      if (scheduledEnd !== null) return scheduledEnd;
      return sub.currentPeriodEnd === null ? null : sub.currentPeriodEnd + grace;
    case "past_due":
    case "unpaid":
      return capped(sub.currentPeriodStart === null ? null : sub.currentPeriodStart + grace);
    case "canceled":
    case "incomplete_expired":
    case "paused":
      return sub.endedAt ?? scheduledEnd ?? sub.trialEnd ?? sub.currentPeriodStart;
    default:
      // `incomplete`: the first payment is still pending or failed.
      return null;
  }
}

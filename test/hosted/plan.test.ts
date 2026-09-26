import { describe, expect, it } from "vitest";
import { entitlementExpiry } from "../../src/hosted/plan.js";
import { DAY, subscription } from "./fake-stripe.js";

const start = 1_790_000_000;
const periodEnd = start + 30 * DAY;
const grace = 3;

describe("entitlementExpiry", () => {
  it("runs a trial to its end", () => {
    const sub = subscription({
      id: "sub_1",
      status: "trialing",
      trialEnd: start + 14 * DAY,
      currentPeriodEnd: start + 14 * DAY,
    });
    expect(entitlementExpiry(sub, grace)).toBe(start + 14 * DAY);
  });

  it("runs an active subscription to its period end plus grace", () => {
    const sub = subscription({ id: "sub_1", currentPeriodStart: start, currentPeriodEnd: periodEnd });
    expect(entitlementExpiry(sub, grace)).toBe(periodEnd + 3 * DAY);
  });

  it("ends a subscription set to cancel exactly at its period end", () => {
    const sub = subscription({
      id: "sub_1",
      currentPeriodStart: start,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: true,
    });
    expect(entitlementExpiry(sub, grace)).toBe(periodEnd);
  });

  it("honors cancel_at, which newer API versions use instead of cancel_at_period_end", () => {
    const sub = subscription({
      id: "sub_1",
      currentPeriodStart: start,
      currentPeriodEnd: periodEnd,
      cancelAt: periodEnd,
    });
    expect(entitlementExpiry(sub, grace)).toBe(periodEnd);
  });

  it("ends a trial that was cancelled at the trial end", () => {
    const trialEnd = start + 14 * DAY;
    const sub = subscription({
      id: "sub_1",
      status: "trialing",
      trialEnd,
      currentPeriodEnd: trialEnd,
      cancelAt: trialEnd,
    });
    expect(entitlementExpiry(sub, grace)).toBe(trialEnd);
  });

  it("keeps only what was paid for while a renewal payment is retried", () => {
    const sub = subscription({
      id: "sub_1",
      status: "past_due",
      currentPeriodStart: periodEnd,
      currentPeriodEnd: periodEnd + 30 * DAY,
    });
    expect(entitlementExpiry(sub, grace)).toBe(periodEnd + 3 * DAY);
  });

  it("ends a cancelled subscription when it ended", () => {
    const sub = subscription({
      id: "sub_1",
      status: "canceled",
      currentPeriodEnd: periodEnd,
      endedAt: start + 10 * DAY,
    });
    expect(entitlementExpiry(sub, grace)).toBe(start + 10 * DAY);
  });

  it("grants nothing while the first payment is incomplete", () => {
    expect(
      entitlementExpiry(subscription({ id: "sub_1", status: "incomplete", currentPeriodEnd: periodEnd }), grace),
    ).toBeNull();
  });
});

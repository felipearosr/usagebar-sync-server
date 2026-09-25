export type RateLimitConfig = {
  /** Sustained requests per minute per client. 0 turns rate limiting off. */
  perMinute: number;
  /** Requests a client can make in a burst, for example a backfill right after pairing. */
  burst: number;
};

export type RateLimitDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

type Bucket = { tokens: number; updatedAt: number };

/** Stop tracking this many clients before pruning the ones whose bucket has refilled. */
const PRUNE_THRESHOLD = 10_000;

/** An in-memory token bucket per client key. State is per process and resets on restart. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perMs: number;

  constructor(private readonly config: RateLimitConfig) {
    this.perMs = config.perMinute / 60_000;
  }

  get enabled() {
    return this.config.perMinute > 0;
  }

  take(key: string, nowMs: number): RateLimitDecision {
    if (!this.enabled) return { ok: true };
    const bucket = this.refill(this.buckets.get(key), nowMs);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(key, bucket);
      if (this.buckets.size > PRUNE_THRESHOLD) this.prune(nowMs);
      return { ok: true };
    }
    this.buckets.set(key, bucket);
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / this.perMs / 1000)) };
  }

  private refill(bucket: Bucket | undefined, nowMs: number): Bucket {
    if (!bucket) return { tokens: this.config.burst, updatedAt: nowMs };
    const elapsed = Math.max(0, nowMs - bucket.updatedAt);
    return { tokens: Math.min(this.config.burst, bucket.tokens + elapsed * this.perMs), updatedAt: nowMs };
  }

  private prune(nowMs: number) {
    for (const [key, bucket] of this.buckets) {
      if (this.refill(bucket, nowMs).tokens >= this.config.burst) this.buckets.delete(key);
    }
  }
}

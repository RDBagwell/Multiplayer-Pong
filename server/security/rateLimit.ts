export interface BucketOptions {
    /** At most `capacity` events per `windowMs` (with bursts up to `capacity`). */
    capacity: number;
    windowMs: number;
}

type Now = () => number;

/**
 * Token bucket: `capacity` tokens, refilled continuously so that `capacity`
 * tokens come back every `windowMs`.
 */
export class TokenBucket {
    private readonly capacity: number;
    private readonly refillPerMs: number;
    private readonly now: Now;
    private tokens: number;
    private updatedAt: number;

    constructor({ capacity, windowMs }: BucketOptions, now: Now = Date.now) {
        this.capacity = capacity;
        this.refillPerMs = capacity / windowMs;
        this.tokens = capacity;
        this.now = now;
        this.updatedAt = now();
    }

    take(cost = 1): boolean {
        const t = this.now();
        this.tokens = Math.min(this.capacity, this.tokens + (t - this.updatedAt) * this.refillPerMs);
        this.updatedAt = t;
        if (this.tokens < cost) return false;
        this.tokens -= cost;
        return true;
    }

    isFull(): boolean {
        this.take(0);
        return this.tokens >= this.capacity;
    }
}

/** One bucket per key (IP address, socket id...), with periodic pruning. */
export class KeyedRateLimiter {
    private readonly options: BucketOptions;
    private readonly now: Now;
    private readonly buckets = new Map<string, TokenBucket>();

    constructor(options: BucketOptions, now: Now = Date.now) {
        this.options = options;
        this.now = now;
    }

    take(key: string, cost = 1): boolean {
        let bucket = this.buckets.get(key);
        if (!bucket) {
            bucket = new TokenBucket(this.options, this.now);
            this.buckets.set(key, bucket);
        }
        return bucket.take(cost);
    }

    /** Drops buckets that have fully refilled, so memory stays bounded. */
    prune(): void {
        for (const [key, bucket] of this.buckets) if (bucket.isFull()) this.buckets.delete(key);
    }

    get size(): number {
        return this.buckets.size;
    }
}

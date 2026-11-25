import type { Clock } from './deps.js';
/** Sliding-window limiter: at most `max` hits per `windowMs`. */
export declare class SlidingWindowLimiter {
    private readonly max;
    private readonly windowMs;
    private readonly clock;
    private hits;
    constructor(max: number, windowMs: number, clock: Clock);
    /** Records a hit and returns true if allowed; returns false (recording nothing) when full. */
    tryHit(): boolean;
}
/** Keyed failure counter used for per-IP login throttling. */
export declare class FailureThrottle {
    private readonly max;
    private readonly windowMs;
    private readonly clock;
    private readonly maxKeys;
    private failures;
    constructor(max: number, windowMs: number, clock: Clock, maxKeys?: number);
    /** Number of tracked keys (exposed for tests: the map must stay bounded). */
    get size(): number;
    private recent;
    isBlocked(key: string): boolean;
    recordFailure(key: string): void;
    reset(key: string): void;
}
/**
 * Account-wide brake for distributed guessing: once `max` failures (any IP) land inside the window,
 * further login attempts are admitted at most once per `slowIntervalMs`. It slows; it never locks
 * the account permanently (the window slides and the real user can still get in).
 */
export declare class GlobalFailureCeiling {
    private readonly max;
    private readonly windowMs;
    private readonly slowIntervalMs;
    private readonly clock;
    private failures;
    private lastAdmitted;
    constructor(max: number, windowMs: number, slowIntervalMs: number, clock: Clock);
    private prune;
    /** True when this attempt may proceed. Under the ceiling every attempt is admitted. */
    admit(): boolean;
    recordFailure(): void;
}
export interface UsageStore {
    used(): number;
    /** Increments synchronously in memory, then persists. Rejects if the persist fails. */
    increment(): Promise<number>;
    /** Refunds one call that was provably never delivered. Floors at 0; same persistence rules as increment(). */
    release(): Promise<number>;
}
/** API-call counter persisted atomically (temp file + rename) to <dir>/usage.json. */
export declare class FileUsageStore implements UsageStore {
    private readonly dir;
    private count;
    private readonly file;
    private writeChain;
    constructor(dir: string);
    private static load;
    used(): number;
    increment(): Promise<number>;
    release(): Promise<number>;
    private persist;
}
/** In-memory store for tests that do not exercise persistence. */
export declare class MemoryUsageStore implements UsageStore {
    private count;
    constructor(count?: number);
    used(): number;
    increment(): Promise<number>;
    release(): Promise<number>;
}

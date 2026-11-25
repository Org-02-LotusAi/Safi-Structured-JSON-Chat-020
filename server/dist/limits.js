import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
/** Sliding-window limiter: at most `max` hits per `windowMs`. */
export class SlidingWindowLimiter {
    max;
    windowMs;
    clock;
    hits = [];
    constructor(max, windowMs, clock) {
        this.max = max;
        this.windowMs = windowMs;
        this.clock = clock;
    }
    /** Records a hit and returns true if allowed; returns false (recording nothing) when full. */
    tryHit() {
        const now = this.clock.now();
        this.hits = this.hits.filter((t) => t > now - this.windowMs);
        if (this.hits.length >= this.max)
            return false;
        this.hits.push(now);
        return true;
    }
}
/** Keyed failure counter used for per-IP login throttling. */
export class FailureThrottle {
    max;
    windowMs;
    clock;
    maxKeys;
    failures = new Map();
    constructor(max, windowMs, clock, maxKeys = 10_000) {
        this.max = max;
        this.windowMs = windowMs;
        this.clock = clock;
        this.maxKeys = maxKeys;
    }
    /** Number of tracked keys (exposed for tests: the map must stay bounded). */
    get size() {
        return this.failures.size;
    }
    recent(key) {
        const cutoff = this.clock.now() - this.windowMs;
        const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
        if (list.length === 0)
            this.failures.delete(key);
        else
            this.failures.set(key, list);
        return list;
    }
    isBlocked(key) {
        return this.recent(key).length >= this.max;
    }
    recordFailure(key) {
        const list = this.recent(key);
        list.push(this.clock.now());
        this.failures.set(key, list);
        // Bound memory: Map iterates in insertion order, so the first key is the oldest-inserted one.
        while (this.failures.size > this.maxKeys) {
            const oldest = this.failures.keys().next().value;
            this.failures.delete(oldest);
        }
    }
    reset(key) {
        this.failures.delete(key);
    }
}
/**
 * Account-wide brake for distributed guessing: once `max` failures (any IP) land inside the window,
 * further login attempts are admitted at most once per `slowIntervalMs`. It slows; it never locks
 * the account permanently (the window slides and the real user can still get in).
 */
export class GlobalFailureCeiling {
    max;
    windowMs;
    slowIntervalMs;
    clock;
    failures = [];
    lastAdmitted = Number.NEGATIVE_INFINITY;
    constructor(max, windowMs, slowIntervalMs, clock) {
        this.max = max;
        this.windowMs = windowMs;
        this.slowIntervalMs = slowIntervalMs;
        this.clock = clock;
    }
    prune() {
        const cutoff = this.clock.now() - this.windowMs;
        this.failures = this.failures.filter((t) => t > cutoff);
    }
    /** True when this attempt may proceed. Under the ceiling every attempt is admitted. */
    admit() {
        this.prune();
        const now = this.clock.now();
        if (this.failures.length < this.max)
            return true;
        if (now - this.lastAdmitted >= this.slowIntervalMs) {
            this.lastAdmitted = now;
            return true;
        }
        return false;
    }
    recordFailure() {
        this.prune();
        this.failures.push(this.clock.now());
        if (this.failures.length > this.max * 4)
            this.failures.splice(0, this.failures.length - this.max * 4);
    }
}
/** API-call counter persisted atomically (temp file + rename) to <dir>/usage.json. */
export class FileUsageStore {
    dir;
    count;
    file;
    writeChain = Promise.resolve();
    constructor(dir) {
        this.dir = dir;
        this.file = path.join(dir, 'usage.json');
        this.count = FileUsageStore.load(this.file);
    }
    static load(file) {
        let raw;
        try {
            raw = fs.readFileSync(file, 'utf8');
        }
        catch (e) {
            if (e.code === 'ENOENT')
                return 0;
            throw new Error(`cannot read usage file: ${e.message}`);
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new Error('usage file is not valid JSON; refusing to reset the cap');
        }
        if (typeof parsed.api_calls_used !== 'number' || !Number.isInteger(parsed.api_calls_used) || parsed.api_calls_used < 0) {
            throw new Error('usage file is corrupt (api_calls_used must be a non-negative integer); refusing to reset the cap');
        }
        return parsed.api_calls_used;
    }
    used() {
        return this.count;
    }
    increment() {
        this.count += 1; // synchronous so the cap check and the increment cannot interleave
        return this.persist();
    }
    release() {
        this.count = Math.max(0, this.count - 1); // synchronous, never below 0
        return this.persist();
    }
    persist() {
        const snapshot = this.count;
        const write = this.writeChain.then(async () => {
            await fs.promises.mkdir(this.dir, { recursive: true });
            const tmp = `${this.file}.${randomUUID()}.tmp`;
            await fs.promises.writeFile(tmp, JSON.stringify({ api_calls_used: snapshot }), 'utf8');
            await fs.promises.rename(tmp, this.file);
        });
        this.writeChain = write.catch(() => { });
        return write.then(() => snapshot);
    }
}
/** In-memory store for tests that do not exercise persistence. */
export class MemoryUsageStore {
    count;
    constructor(count = 0) {
        this.count = count;
    }
    used() {
        return this.count;
    }
    async increment() {
        this.count += 1;
        return this.count;
    }
    async release() {
        this.count = Math.max(0, this.count - 1);
        return this.count;
    }
}

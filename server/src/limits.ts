import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from './deps.js';

/** Sliding-window limiter: at most `max` hits per `windowMs`. */
export class SlidingWindowLimiter {
  private hits: number[] = [];
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly clock: Clock,
  ) {}

  /** Records a hit and returns true if allowed; returns false (recording nothing) when full. */
  tryHit(): boolean {
    const now = this.clock.now();
    this.hits = this.hits.filter((t) => t > now - this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

/** Keyed failure counter used for per-IP login throttling. */
export class FailureThrottle {
  private failures = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly clock: Clock,
    private readonly maxKeys = 10_000,
  ) {}

  /** Number of tracked keys (exposed for tests: the map must stay bounded). */
  get size(): number {
    return this.failures.size;
  }

  private recent(key: string): number[] {
    const cutoff = this.clock.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.failures.delete(key);
    else this.failures.set(key, list);
    return list;
  }

  isBlocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  recordFailure(key: string): void {
    const list = this.recent(key);
    list.push(this.clock.now());
    this.failures.set(key, list);
    // Bound memory: Map iterates in insertion order, so the first key is the oldest-inserted one.
    while (this.failures.size > this.maxKeys) {
      const oldest = this.failures.keys().next().value as string;
      this.failures.delete(oldest);
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}

/**
 * Account-wide brake for distributed guessing: once `max` failures (any IP) land inside the window,
 * further login attempts are admitted at most once per `slowIntervalMs`. It slows; it never locks
 * the account permanently (the window slides and the real user can still get in).
 */
export class GlobalFailureCeiling {
  private failures: number[] = [];
  private lastAdmitted = Number.NEGATIVE_INFINITY;
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly slowIntervalMs: number,
    private readonly clock: Clock,
  ) {}

  private prune(): void {
    const cutoff = this.clock.now() - this.windowMs;
    this.failures = this.failures.filter((t) => t > cutoff);
  }

  /** True when this attempt may proceed. Under the ceiling every attempt is admitted. */
  admit(): boolean {
    this.prune();
    const now = this.clock.now();
    if (this.failures.length < this.max) return true;
    if (now - this.lastAdmitted >= this.slowIntervalMs) {
      this.lastAdmitted = now;
      return true;
    }
    return false;
  }

  recordFailure(): void {
    this.prune();
    this.failures.push(this.clock.now());
    if (this.failures.length > this.max * 4) this.failures.splice(0, this.failures.length - this.max * 4);
  }
}

export interface UsageStore {
  used(): number;
  /** Increments synchronously in memory, then persists. Rejects if the persist fails. */
  increment(): Promise<number>;
  /** Refunds one call that was provably never delivered. Floors at 0; same persistence rules as increment(). */
  release(): Promise<number>;
}

/** API-call counter persisted atomically (temp file + rename) to <dir>/usage.json. */
export class FileUsageStore implements UsageStore {
  private count: number;
  private readonly file: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {
    this.file = path.join(dir, 'usage.json');
    this.count = FileUsageStore.load(this.file);
  }

  private static load(file: string): number {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw new Error(`cannot read usage file: ${(e as Error).message}`);
    }
    let parsed: { api_calls_used?: unknown };
    try {
      parsed = JSON.parse(raw) as { api_calls_used?: unknown };
    } catch {
      throw new Error('usage file is not valid JSON; refusing to reset the cap');
    }
    if (typeof parsed.api_calls_used !== 'number' || !Number.isInteger(parsed.api_calls_used) || parsed.api_calls_used < 0) {
      throw new Error('usage file is corrupt (api_calls_used must be a non-negative integer); refusing to reset the cap');
    }
    return parsed.api_calls_used;
  }

  used(): number {
    return this.count;
  }

  increment(): Promise<number> {
    this.count += 1; // synchronous so the cap check and the increment cannot interleave
    return this.persist();
  }

  release(): Promise<number> {
    this.count = Math.max(0, this.count - 1); // synchronous, never below 0
    return this.persist();
  }

  private persist(): Promise<number> {
    const snapshot = this.count;
    const write = this.writeChain.then(async () => {
      await fs.promises.mkdir(this.dir, { recursive: true });
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify({ api_calls_used: snapshot }), 'utf8');
      await fs.promises.rename(tmp, this.file);
    });
    this.writeChain = write.catch(() => {});
    return write.then(() => snapshot);
  }
}

/** In-memory store for tests that do not exercise persistence. */
export class MemoryUsageStore implements UsageStore {
  constructor(private count = 0) {}
  used(): number {
    return this.count;
  }
  async increment(): Promise<number> {
    this.count += 1;
    return this.count;
  }
  async release(): Promise<number> {
    this.count = Math.max(0, this.count - 1);
    return this.count;
  }
}

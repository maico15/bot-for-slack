// ---------------------------------------------------------------------------
// TTLMap – generic Map with per-entry expiry
// ---------------------------------------------------------------------------
export class TTLMap<K, V> {
  private readonly store = new Map<K, { value: V; expiresAt: number }>();
  readonly defaultTtlMs: number;

  constructor(defaultTtlMs: number) {
    this.defaultTtlMs = defaultTtlMs;
  }

  set(key: K, value: V, ttlMs?: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.store.delete(key);
  }

  /** Evict all expired entries. Called by the cleanup interval. */
  cleanup(): void {
    const now = Date.now();
    for (const [k, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(k);
    }
  }

  /** Return all non-expired values; lazily evicts expired ones while iterating. */
  values(): V[] {
    const now = Date.now();
    const out: V[] = [];
    for (const [k, entry] of this.store) {
      if (now <= entry.expiresAt) out.push(entry.value);
      else this.store.delete(k);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// TTL constants (ms)
// ---------------------------------------------------------------------------
export const TTL = {
  EVENT_ID:   30 * 60 * 1000,           // 30 min  – Slack event dedup
  THREAD:     24 * 60 * 60 * 1000,      // 24 h    – one bot reply per thread
  COOLDOWN:   90 * 1000,                // 90 s    – per-user spam guard
  ESCALATION: 7 * 24 * 60 * 60 * 1000, // 7 days  – 🧵 reaction dedup
  STATS:      7 * 24 * 60 * 60 * 1000, // 7 days  – metrics retention
} as const;

// ---------------------------------------------------------------------------
// Map instances
// TODO: Replace with Redis for persistence across restarts
// ---------------------------------------------------------------------------

/** Dedup by Slack event_id — key = event_id (30 min) */
export const seenEventIds = new TTLMap<string, true>(TTL.EVENT_ID);

/** One bot reply per thread root — key = `${channelId}:${rootTs}` (24 h) */
export const handledRoots = new TTLMap<string, true>(TTL.THREAD);

/** Per-user spam guard — key = userId (90 s) */
export const userCooldown = new TTLMap<string, true>(TTL.COOLDOWN);

/** Thread metrics — key = `${channelId}:${rootTs}` (7 days) */
export interface MetricEntry {
  intentId: string;
  status: 'open' | 'solved' | 'unsolved';
  createdAt: number;
  updatedAt: number;
  escalated?: boolean;
}
export const metrics = new TTLMap<string, MetricEntry>(TTL.STATS);

/** 🧵 reaction escalation dedup — key = `${channelId}:${rootTs}` (7 days) */
export const reactionEscalated = new TTLMap<string, true>(TTL.ESCALATION);

/** Thread context for escalation DMs — key = `${channelId}:${rootTs}` (24 h) */
export interface ThreadContext {
  userId: string;
  userText: string;
  botReplyText: string;
  intentId: string;
}
export const threadContexts = new TTLMap<string, ThreadContext>(TTL.THREAD);

/** Bot message ts → metricsKey — used to map reactions back to threads (24 h) */
export const botMsgToThread = new TTLMap<string, { metricsKey: string }>(TTL.THREAD);

// ---------------------------------------------------------------------------
// Cleanup — call startCleanup() once at app bootstrap; runs every 60 seconds
// ---------------------------------------------------------------------------
export function startCleanup(): NodeJS.Timeout {
  return setInterval(() => {
    seenEventIds.cleanup();
    handledRoots.cleanup();
    userCooldown.cleanup();
    metrics.cleanup();
    reactionEscalated.cleanup();
    threadContexts.cleanup();
    botMsgToThread.cleanup();
  }, 60_000);
}

// ---------------------------------------------------------------------------
// Stats report (used by /flexbot stats)
// ---------------------------------------------------------------------------
export function computeStats(): string {
  const entries = metrics.values();
  const total   = entries.length;
  if (total === 0) return 'No triggers recorded yet.';

  const solved      = entries.filter((e) => e.status === 'solved').length;
  const unsolved    = entries.filter((e) => e.status === 'unsolved').length;
  const unknown     = entries.filter((e) => e.intentId === 'unknown').length;
  const unknownRate = ((unknown / total) * 100).toFixed(1);

  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.intentId] = (counts[e.intentId] ?? 0) + 1;

  const top5 = Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name, n]) => `• ${name}: ${n}`)
    .join('\n');

  return [
    '*System Assistant — Stats (last 7 days)*',
    `*Total:* ${total}  |  *Solved ✅:* ${solved}  |  *Unsolved ❌:* ${unsolved}`,
    `*Unknown:* ${unknown} (${unknownRate}%)`,
    '',
    '*Top intents:*',
    top5,
  ].join('\n');
}

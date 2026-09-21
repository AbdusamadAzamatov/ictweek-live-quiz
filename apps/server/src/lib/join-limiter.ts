import type { Socket } from 'socket.io';

export type JoinLimiterOptions = {
  /** Failed PIN lookups allowed per sliding window (default 120). */
  failPerMin?: number;
  /** Failed PIN lookups allowed per sliding hour (default 1000). */
  failPerHour?: number;
  /** Successful joins allowed per sliding minute (default 1200). */
  successPerMin?: number;
  /** Failure window length in ms (default 60_000); tests may shrink it. */
  failWindowMs?: number;
  sweepMs?: number;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Timestamps are appended in non-decreasing order; count those >= cutoff. */
function countSince(stamps: number[], cutoff: number): number {
  let i = 0;
  while (i < stamps.length && stamps[i]! < cutoff) i += 1;
  return stamps.length - i;
}

/**
 * Shared per-IP sliding-window limiter for PIN lookups / player:join (DESIGN §7).
 * Keyed by IP so it survives socket reconnects and is shared between the HTTP
 * join-info route and the Socket.IO join path. Separate budgets for failures
 * (enumeration) and successes (venue NAT mass-join).
 */
export class JoinLimiter {
  private readonly failPerMin: number;
  private readonly failPerHour: number;
  private readonly successPerMin: number;
  private readonly failWindowMs: number;
  private readonly fails = new Map<string, number[]>();
  private readonly oks = new Map<string, number[]>();
  private readonly timer: NodeJS.Timeout;

  constructor(opts: JoinLimiterOptions = {}) {
    this.failPerMin = opts.failPerMin ?? 120;
    this.failPerHour = opts.failPerHour ?? 1000;
    this.successPerMin = opts.successPerMin ?? 1200;
    this.failWindowMs = opts.failWindowMs ?? MINUTE_MS;
    this.timer = setInterval(() => this.sweep(), opts.sweepMs ?? MINUTE_MS);
    this.timer.unref();
  }

  check(ip: string): 'ok' | 'limited' {
    const now = Date.now();
    const fails = this.prune(this.fails, ip, now - HOUR_MS);
    if (countSince(fails, now - this.failWindowMs) >= this.failPerMin) return 'limited';
    if (fails.length >= this.failPerHour) return 'limited';
    const oks = this.prune(this.oks, ip, now - MINUTE_MS);
    if (oks.length >= this.successPerMin) return 'limited';
    return 'ok';
  }

  recordFailure(ip: string): void {
    const stamps = this.prune(this.fails, ip, Date.now() - HOUR_MS);
    stamps.push(Date.now());
    this.fails.set(ip, stamps);
  }

  recordSuccess(ip: string): void {
    const stamps = this.prune(this.oks, ip, Date.now() - MINUTE_MS);
    stamps.push(Date.now());
    this.oks.set(ip, stamps);
  }

  stats(): { trackedIps: number; limitedIps: number } {
    const ips = new Set([...this.fails.keys(), ...this.oks.keys()]);
    let limitedIps = 0;
    for (const ip of ips) {
      if (this.check(ip) === 'limited') limitedIps += 1;
    }
    return { trackedIps: ips.size, limitedIps };
  }

  dispose(): void {
    clearInterval(this.timer);
    this.fails.clear();
    this.oks.clear();
  }

  /** Prune stamps older than cutoff; removes the entry when it goes empty. */
  private prune(map: Map<string, number[]>, ip: string, cutoff: number): number[] {
    const stamps = map.get(ip);
    if (!stamps) return [];
    const kept = stamps.filter((t) => t >= cutoff);
    if (kept.length === 0) map.delete(ip);
    else if (kept.length !== stamps.length) map.set(ip, kept);
    return kept;
  }

  /** Drop IPs whose newest timestamp has fallen out of every window. */
  private sweep(): void {
    const now = Date.now();
    for (const [ip, stamps] of this.fails) {
      if (!stamps.length || stamps[stamps.length - 1]! < now - HOUR_MS) this.fails.delete(ip);
    }
    for (const [ip, stamps] of this.oks) {
      if (!stamps.length || stamps[stamps.length - 1]! < now - MINUTE_MS) this.oks.delete(ip);
    }
  }
}

/**
 * Client IP for a socket handshake. With TRUST_PROXY=1 the first entry of
 * X-Forwarded-For is trusted (Caddy sets it); otherwise the peer address.
 */
export function socketClientIp(socket: Socket, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = socket.handshake.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return socket.handshake.address;
}

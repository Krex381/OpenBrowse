import type { ClientRenderAnalysis } from "./types.js";

export interface DomainObservation {
  samples: number;
  shellRatio: number;
  lastSeenAt: number;
}

type MutableObservation = {
  shells: number;
  sufficient: number;
  lastSeenAt: number;
};

/**
 * Bounded process-local evidence. It informs diagnostics and relative cost but
 * never bypasses the HTTP-first probe, so stale history cannot force a browser.
 */
export class DomainObservationStore {
  private readonly entries = new Map<string, MutableObservation>();

  constructor(
    private readonly maximumEntries = 512,
    private readonly maximumSamplesPerDomain = 20,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
  ) {}

  get(url: string, now = Date.now()): DomainObservation | undefined {
    const key = hostname(url);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now - entry.lastSeenAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    const samples = entry.shells + entry.sufficient;
    return {
      samples,
      shellRatio: Number((entry.shells / Math.max(1, samples)).toFixed(2)),
      lastSeenAt: entry.lastSeenAt,
    };
  }

  record(
    url: string,
    analysis: ClientRenderAnalysis,
    now = Date.now(),
  ): void {
    if (
      analysis.reason !== "client-rendered-shell" &&
      analysis.reason !== "http-content-sufficient"
    )
      return;
    const key = hostname(url);
    const entry = this.entries.get(key) ?? {
      shells: 0,
      sufficient: 0,
      lastSeenAt: now,
    };
    if (analysis.reason === "client-rendered-shell") entry.shells++;
    else entry.sufficient++;
    while (entry.shells + entry.sufficient > this.maximumSamplesPerDomain) {
      if (entry.shells >= entry.sufficient) entry.shells--;
      else entry.sufficient--;
    }
    entry.lastSeenAt = now;
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maximumEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}

function hostname(value: string): string {
  return new URL(value).hostname.toLowerCase().replace(/\.$/, "");
}

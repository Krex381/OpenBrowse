import { config } from "./config.js";
import { Storage } from "./storage.js";

interface Entry {
  body: Buffer;
  metadata: Record<string, unknown>;
  expiresAt: number;
}

export class Cache {
  private readonly memory = new Map<string, Entry>();
  private memoryBytes = 0;
  private readonly inflight = new Map<string, Promise<unknown>>();
  constructor(private readonly storage: Storage) {}

  async get(key: string): Promise<
    | {
        body: Buffer;
        metadata: Record<string, unknown>;
        layer: "memory" | "disk";
      }
    | undefined
  > {
    const entry = this.memory.get(key);
    if (entry) {
      if (entry.expiresAt >= Date.now()) {
        this.memory.delete(key);
        this.memory.set(key, entry);
        return { body: entry.body, metadata: entry.metadata, layer: "memory" };
      }
      this.removeMemory(key, entry);
    }
    const disk = await this.storage.getCache(key);
    if (!disk) return undefined;
    this.putMemory(key, { ...disk, expiresAt: Date.now() + 60000 });
    return { ...disk, layer: "disk" };
  }
  async put(
    key: string,
    body: Buffer,
    ttlSeconds: number,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.storage.putCache(key, body, ttlSeconds, metadata);
    this.putMemory(key, {
      body,
      metadata,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }
  async purge(value?: string): Promise<number> {
    this.memory.clear();
    this.memoryBytes = 0;
    return this.storage.purgeCache(value);
  }
  stats(): {
    memory: { entries: number; bytes: number };
    disk: { entries: number; bytes: number };
  } {
    const disk = this.storage.cacheStats().disk;
    return {
      memory: { entries: this.memory.size, bytes: this.memoryBytes },
      disk,
    };
  }
  coalesce<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const task = factory().finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }
  private putMemory(key: string, entry: Entry): void {
    const previous = this.memory.get(key);
    if (previous) this.removeMemory(key, previous);
    this.memory.set(key, entry);
    this.memoryBytes += entry.body.length;
    while (this.memoryBytes > config.cacheMemoryBytes) {
      const oldest = this.memory.entries().next().value as
        | [string, Entry]
        | undefined;
      if (!oldest) break;
      this.removeMemory(...oldest);
    }
  }
  private removeMemory(key: string, entry: Entry): void {
    this.memory.delete(key);
    this.memoryBytes -= entry.body.length;
  }
}

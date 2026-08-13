import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import type { SqlRow } from "./types.js";

export class CacheStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly cacheDir: string,
  ) {}
  async get(
    key: string,
  ): Promise<{ body: Buffer; metadata: Record<string, unknown> } | undefined> {
    const row = this.db
      .prepare(
        "SELECT path, expires_at, metadata FROM cache_entries WHERE key = ?",
      )
      .get(key) as SqlRow | undefined;
    if (!row || Number(row.expires_at) < Date.now()) {
      if (row) await this.delete(key, String(row.path));
      return undefined;
    }
    try {
      const body = await readFile(String(row.path));
      this.db
        .prepare("UPDATE cache_entries SET last_access = ? WHERE key = ?")
        .run(Date.now(), key);
      return {
        body,
        metadata: JSON.parse(String(row.metadata)) as Record<string, unknown>,
      };
    } catch {
      await this.delete(key, String(row.path));
      return undefined;
    }
  }
  async put(
    key: string,
    body: Buffer,
    ttlSeconds: number,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const hash = key.replace("sha256:", "");
    const path = join(this.cacheDir, hash.slice(0, 2), hash.slice(2, 4), hash);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, { flag: "w" });
    const now = Date.now();
    this.db
      .prepare(
        "INSERT OR REPLACE INTO cache_entries(key,path,bytes,expires_at,last_access,metadata) VALUES(?,?,?,?,?,?)",
      )
      .run(
        key,
        path,
        body.length,
        now + ttlSeconds * 1000,
        now,
        JSON.stringify(metadata),
      );
    await this.evict();
  }
  async purge(value?: string): Promise<number> {
    const rows = (
      value
        ? this.db
            .prepare("SELECT key,path FROM cache_entries WHERE metadata LIKE ?")
            .all(`%${value}%`)
        : this.db.prepare("SELECT key,path FROM cache_entries").all()
    ) as SqlRow[];
    await Promise.all(
      rows.map((row) => this.delete(String(row.key), String(row.path))),
    );
    return rows.length;
  }
  stats(): {
    memory: { entries: number; bytes: number };
    disk: { entries: number; bytes: number };
  } {
    const disk = this.db
      .prepare(
        "SELECT COUNT(*) AS entries, COALESCE(SUM(bytes),0) AS bytes FROM cache_entries",
      )
      .get() as SqlRow;
    return {
      memory: { entries: 0, bytes: 0 },
      disk: { entries: Number(disk.entries), bytes: Number(disk.bytes) },
    };
  }
  private async delete(key: string, path: string): Promise<void> {
    this.db.prepare("DELETE FROM cache_entries WHERE key = ?").run(key);
    await unlink(path).catch(() => undefined);
  }
  private async evict(): Promise<void> {
    const total = this.db
      .prepare("SELECT COALESCE(SUM(bytes),0) AS bytes FROM cache_entries")
      .get() as SqlRow;
    if (Number(total.bytes) <= config.cacheDiskBytes) return;
    const rows = this.db
      .prepare(
        "SELECT key,path FROM cache_entries ORDER BY expires_at ASC, last_access ASC",
      )
      .all() as SqlRow[];
    for (const row of rows) {
      await this.delete(String(row.key), String(row.path));
      const current = this.db
        .prepare("SELECT COALESCE(SUM(bytes),0) AS bytes FROM cache_entries")
        .get() as SqlRow;
      if (Number(current.bytes) <= Math.floor(config.cacheDiskBytes * 0.75))
        return;
    }
  }
}

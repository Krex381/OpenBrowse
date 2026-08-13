import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SecretBox } from "./crypto.js";
import type { SqlRow, StoredWebhook, UsageSummary } from "./types.js";

export class OperationsStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly secrets: SecretBox,
  ) {}
  createWebhook(
    url: string,
    events: string[],
    ownerKeyHash: string,
  ): Omit<StoredWebhook, "secret"> & { secret: string } {
    const id = `whk_${randomUUID().replaceAll("-", "")}`;
    const secret = randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO webhooks(id,owner_key_hash,url,events,secret) VALUES(?,?,?,?,?)")
      .run(
        id,
        ownerKeyHash,
        this.secrets.encrypt(url),
        JSON.stringify(events),
        this.secrets.encrypt(secret),
      );
    return { id, ownerKeyHash, url, events, secret };
  }
  listWebhooks(ownerKeyHash: string): StoredWebhook[] {
    return (this.db.prepare("SELECT * FROM webhooks WHERE owner_key_hash=?").all(ownerKeyHash) as SqlRow[]).map(
      (row) => ({
        id: String(row.id),
        ownerKeyHash,
        url: this.secrets.decrypt(String(row.url)),
        events: JSON.parse(String(row.events)) as string[],
        secret: this.secrets.decrypt(String(row.secret)),
      }),
    );
  }
  deleteWebhook(id: string, ownerKeyHash: string): boolean {
    return (
      this.db.prepare("DELETE FROM webhooks WHERE id=? AND owner_key_hash=?").run(id, ownerKeyHash).changes > 0
    );
  }
  audit(id: string, operation: string, statusCode: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO request_audit VALUES(?,?,?,?)")
      .run(id, operation, statusCode, Date.now());
  }
  reserveUsage(keyHash: string, dailyLimit: number): UsageSummary | undefined {
    const day = new Date().toISOString().slice(0, 10);
    const current = this.getUsage(keyHash, day);
    if (dailyLimit > 0 && current.requests >= dailyLimit) return undefined;
    this.db
      .prepare(
        "INSERT INTO usage_counters(key_hash,day,requests,successful,failed) VALUES(?,?,1,0,0) ON CONFLICT(key_hash,day) DO UPDATE SET requests=requests+1",
      )
      .run(keyHash, day);
    return this.getUsage(keyHash, day);
  }
  recordUsageOutcome(keyHash: string, statusCode: number): void {
    const day = new Date().toISOString().slice(0, 10);
    this.db
      .prepare(
        "UPDATE usage_counters SET successful=successful+?, failed=failed+? WHERE key_hash=? AND day=?",
      )
      .run(statusCode < 400 ? 1 : 0, statusCode >= 400 ? 1 : 0, keyHash, day);
  }
  getUsage(
    keyHash: string,
    day = new Date().toISOString().slice(0, 10),
  ): UsageSummary {
    const row = this.db
      .prepare(
        "SELECT requests,successful,failed FROM usage_counters WHERE key_hash=? AND day=?",
      )
      .get(keyHash, day) as SqlRow | undefined;
    return {
      day,
      requests: Number(row?.requests ?? 0),
      successful: Number(row?.successful ?? 0),
      failed: Number(row?.failed ?? 0),
    };
  }
}

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SqlRow } from "./types.js";

export type SessionHandoff = {
  id: string;
  sessionId: string;
  expiresAt: number;
};

/** One-time, opaque grants used to move a live session between API-key owners. */
export class HandoffStore {
  constructor(private readonly db: DatabaseSync) {}

  create(sessionId: string, ttlSeconds: number): SessionHandoff & { token: string } {
    const token = randomBytes(32).toString("base64url");
    const handoff: SessionHandoff = {
      id: `hof_${randomUUID().replaceAll("-", "")}`,
      sessionId,
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
    this.db
      .prepare(
        "INSERT INTO session_handoffs(id,session_id,token_hash,expires_at,redeemed_at) VALUES(?,?,?,?,NULL)",
      )
      .run(
        handoff.id,
        handoff.sessionId,
        createHash("sha256").update(token).digest("hex"),
        handoff.expiresAt,
      );
    return { ...handoff, token };
  }

  redeem(token: string): SessionHandoff | undefined {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const row = this.db
      .prepare(
        "SELECT id,session_id,expires_at FROM session_handoffs WHERE token_hash=? AND redeemed_at IS NULL AND expires_at>=?",
      )
      .get(tokenHash, Date.now()) as SqlRow | undefined;
    if (!row) return undefined;
    const changes = this.db
      .prepare(
        "UPDATE session_handoffs SET redeemed_at=? WHERE id=? AND redeemed_at IS NULL",
      )
      .run(Date.now(), String(row.id)).changes;
    if (!changes) return undefined;
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      expiresAt: Number(row.expires_at),
    };
  }

  revokeForSession(sessionId: string): void {
    this.db.prepare("DELETE FROM session_handoffs WHERE session_id=?").run(sessionId);
  }
}

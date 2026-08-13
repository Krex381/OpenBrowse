import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SqlRow, StoredJob, StoredReplay } from "./types.js";

export class JobStore {
  constructor(private readonly db: DatabaseSync) {}
  create(
    operation: string,
    request: string,
    ttlSeconds: number,
    ownerKeyHash: string,
  ): StoredJob {
    const job = {
      id: `job_${randomUUID().replaceAll("-", "")}`,
      ownerKeyHash,
      operation,
      request,
      status: "queued" as const,
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
    this.db
      .prepare(
        "INSERT INTO jobs(id,owner_key_hash,operation,request,status,expires_at) VALUES(?,?,?,?,?,?)",
      )
      .run(job.id, job.ownerKeyHash, job.operation, job.request, job.status, job.expiresAt);
    return job;
  }
  get(id: string, ownerKeyHash: string): StoredJob | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=? AND owner_key_hash=?").get(id, ownerKeyHash) as
      | SqlRow
      | undefined;
    return row
      ? {
          id,
          ownerKeyHash,
          operation: String(row.operation),
          request: String(row.request),
          status: String(row.status) as StoredJob["status"],
          ...(row.artifact_id ? { artifactId: String(row.artifact_id) } : {}),
          ...(row.result ? { result: String(row.result) } : {}),
          ...(row.error ? { error: String(row.error) } : {}),
          expiresAt: Number(row.expires_at),
        }
      : undefined;
  }
  update(id: string, ownerKeyHash: string, patch: Partial<StoredJob>): void {
    this.db
      .prepare(
        "UPDATE jobs SET status=?, artifact_id=?, result=?, error=? WHERE id=? AND owner_key_hash=?",
      )
      .run(
        patch.status ?? this.get(id, ownerKeyHash)?.status ?? "failed",
        patch.artifactId ?? null,
        patch.result ?? null,
        patch.error ?? null,
        id,
        ownerKeyHash,
      );
  }
  createReplay(
    sessionId: string,
    artifactId: string,
    ttlSeconds: number,
    ownerKeyHash: string,
  ): StoredReplay {
    const replay = {
      id: `rpl_${randomUUID().replaceAll("-", "")}`,
      ownerKeyHash,
      sessionId,
      artifactId,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
    this.db
      .prepare("INSERT INTO replays(id,owner_key_hash,session_id,artifact_id,created_at,expires_at) VALUES(?,?,?,?,?,?)")
      .run(
        replay.id,
        replay.ownerKeyHash,
        replay.sessionId,
        replay.artifactId,
        replay.createdAt,
        replay.expiresAt,
      );
    return replay;
  }
  getReplay(id: string, ownerKeyHash: string): StoredReplay | undefined {
    const row = this.db.prepare("SELECT * FROM replays WHERE id=? AND owner_key_hash=?").get(id, ownerKeyHash) as
      | SqlRow
      | undefined;
    return row && Number(row.expires_at) >= Date.now()
      ? {
          id,
          ownerKeyHash,
          sessionId: String(row.session_id),
          artifactId: String(row.artifact_id),
          createdAt: Number(row.created_at),
          expiresAt: Number(row.expires_at),
        }
      : undefined;
  }
}

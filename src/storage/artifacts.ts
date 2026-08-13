import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Artifact, SqlRow } from "./types.js";

export class ArtifactStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly artifactsDir: string,
  ) {}
  async create(
    body: Buffer,
    contentType: string,
    ownerKeyHash: string,
    ttlSeconds = 3600,
  ): Promise<Artifact> {
    const id = `art_${randomUUID().replaceAll("-", "")}`;
    const path = join(this.artifactsDir, id);
    await writeFile(path, body, { flag: "wx" });
    const artifact = {
      id,
      ownerKeyHash,
      path,
      contentType,
      bytes: body.length,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
    this.db
      .prepare("INSERT INTO artifacts(id,owner_key_hash,path,content_type,bytes,created_at,expires_at) VALUES(?,?,?,?,?,?,?)")
      .run(
        artifact.id,
        artifact.ownerKeyHash,
        artifact.path,
        artifact.contentType,
        artifact.bytes,
        artifact.createdAt,
        artifact.expiresAt,
      );
    return artifact;
  }
  async get(
    id: string,
    ownerKeyHash: string,
  ): Promise<{ artifact: Artifact; body: Buffer } | undefined> {
    const row = this.db
      .prepare("SELECT * FROM artifacts WHERE id = ? AND owner_key_hash = ?")
      .get(id, ownerKeyHash) as SqlRow | undefined;
    if (!row || Number(row.expires_at) < Date.now()) return undefined;
    try {
      return {
        artifact: {
          id,
          ownerKeyHash,
          path: String(row.path),
          contentType: String(row.content_type),
          bytes: Number(row.bytes),
          createdAt: Number(row.created_at),
          expiresAt: Number(row.expires_at),
        },
        body: await readFile(String(row.path)),
      };
    } catch {
      return undefined;
    }
  }
}

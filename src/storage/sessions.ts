import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import { OpenBrowseError } from "../errors.js";
import { SecretBox } from "./crypto.js";
import type { SqlRow, StoredBrowserProfile, StoredSession } from "./types.js";

export class SessionStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly profilesDir: string,
    private readonly secrets: SecretBox,
  ) {
    this.migrateLegacySessionState();
  }
  profilePath(id: string): string {
    return join(this.profilesDir, id);
  }
  create(input: Omit<StoredSession, "id" | "createdAt">): StoredSession {
    const session = {
      id: `ses_${randomUUID().replaceAll("-", "")}`,
      createdAt: Date.now(),
      ...input,
    };
    this.db
      .prepare(
        "INSERT INTO sessions(id,persistent,created_at,expires_at,viewport,proxy_id,storage_state,owner_key_hash,live_viewer) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        session.id,
        session.persistent ? 1 : 0,
        session.createdAt,
        session.expiresAt,
        JSON.stringify(session.viewport),
        session.proxyId ?? null,
        session.storageState ? this.secrets.encrypt(session.storageState) : null,
        session.ownerKeyHash ?? null,
        session.liveViewer ? 1 : 0,
      );
    return session;
  }
  get(id: string): StoredSession | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as
      | SqlRow
      | undefined;
    if (!row || Number(row.expires_at) < Date.now()) return undefined;
    return {
      id,
      ...(row.owner_key_hash
        ? { ownerKeyHash: String(row.owner_key_hash) }
        : {}),
      persistent: Boolean(row.persistent),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      viewport: JSON.parse(String(row.viewport)) as {
        width: number;
        height: number;
      },
      ...(row.proxy_id ? { proxyId: String(row.proxy_id) } : {}),
      ...(row.storage_state
        ? { storageState: this.secrets.decrypt(String(row.storage_state)) }
        : {}),
      ...(Boolean(row.live_viewer) ? { liveViewer: true } : {}),
    };
  }
  list(ownerKeyHash: string): StoredSession[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM sessions WHERE owner_key_hash=? AND expires_at>=? ORDER BY created_at DESC",
        )
        .all(ownerKeyHash, Date.now()) as SqlRow[]
    ).map((row) => ({
      id: String(row.id),
      ownerKeyHash,
      persistent: Boolean(row.persistent),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      viewport: JSON.parse(String(row.viewport)) as {
        width: number;
        height: number;
      },
      ...(row.proxy_id ? { proxyId: String(row.proxy_id) } : {}),
      ...(row.storage_state
        ? { storageState: this.secrets.decrypt(String(row.storage_state)) }
        : {}),
      ...(Boolean(row.live_viewer) ? { liveViewer: true } : {}),
    }));
  }
  updateState(id: string, storageState: string): void {
    this.db
      .prepare("UPDATE sessions SET storage_state=? WHERE id=?")
      .run(this.secrets.encrypt(storageState), id);
  }
  transferOwner(id: string, ownerKeyHash: string): boolean {
    return (
      this.db
        .prepare("UPDATE sessions SET owner_key_hash=? WHERE id=? AND expires_at>=?")
        .run(ownerKeyHash, id, Date.now()).changes > 0
    );
  }
  async delete(id: string): Promise<boolean> {
    const found = this.get(id);
    this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
    await rm(this.profilePath(id), { recursive: true, force: true });
    return Boolean(found);
  }
  createProfile(input: {
    ownerKeyHash: string;
    name: string;
    storageState: string;
  }): StoredBrowserProfile {
    if (!config.encryptionKey)
      throw new OpenBrowseError(
        "INVALID_REQUEST",
        "OPENBROWSE_ENCRYPTION_KEY is required to persist authenticated browser profiles",
        400,
      );
    const now = Date.now();
    const profile: StoredBrowserProfile = {
      id: `prf_${randomUUID().replaceAll("-", "")}`,
      ownerKeyHash: input.ownerKeyHash,
      name: input.name,
      storageState: input.storageState,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO browser_profiles(id,owner_key_hash,name,storage_state,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        profile.id,
        profile.ownerKeyHash,
        profile.name,
        this.secrets.encrypt(profile.storageState),
        profile.createdAt,
        profile.updatedAt,
      );
    return profile;
  }
  getProfile(
    id: string,
    ownerKeyHash: string,
  ): StoredBrowserProfile | undefined {
    return this.profile(
      this.db
        .prepare(
          "SELECT * FROM browser_profiles WHERE id=? AND owner_key_hash=?",
        )
        .get(id, ownerKeyHash) as SqlRow | undefined,
      ownerKeyHash,
    );
  }
  getProfileByName(
    name: string,
    ownerKeyHash: string,
  ): StoredBrowserProfile | undefined {
    return this.profile(
      this.db
        .prepare(
          "SELECT * FROM browser_profiles WHERE name=? AND owner_key_hash=?",
        )
        .get(name, ownerKeyHash) as SqlRow | undefined,
      ownerKeyHash,
    );
  }
  listProfiles(
    ownerKeyHash: string,
  ): Array<Omit<StoredBrowserProfile, "storageState">> {
    return (
      this.db
        .prepare(
          "SELECT id,name,created_at,updated_at FROM browser_profiles WHERE owner_key_hash=? ORDER BY updated_at DESC",
        )
        .all(ownerKeyHash) as SqlRow[]
    ).map((row) => ({
      id: String(row.id),
      ownerKeyHash,
      name: String(row.name),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }
  deleteProfile(id: string, ownerKeyHash: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM browser_profiles WHERE id=? AND owner_key_hash=?")
        .run(id, ownerKeyHash).changes > 0
    );
  }
  private profile(
    row: SqlRow | undefined,
    ownerKeyHash: string,
  ): StoredBrowserProfile | undefined {
    return row
      ? {
          id: String(row.id),
          ownerKeyHash,
          name: String(row.name),
          storageState: this.secrets.decrypt(String(row.storage_state)),
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
        }
      : undefined;
  }
  private migrateLegacySessionState(): void {
    const rows = this.db
      .prepare(
        "SELECT id,storage_state FROM sessions WHERE storage_state IS NOT NULL",
      )
      .all() as SqlRow[];
    const update = this.db.prepare(
      "UPDATE sessions SET storage_state=? WHERE id=?",
    );
    for (const row of rows) {
      const storageState = String(row.storage_state);
      if (!storageState.startsWith("v1:"))
        update.run(this.secrets.encrypt(storageState), String(row.id));
    }
  }
}

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SecretBox } from "../../src/storage/crypto.js";
import { SessionStore } from "../../src/storage/sessions.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("persistent session state encryption", () => {
  it("migrates legacy plaintext session state at startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbrowse-session-test-"));
    directories.push(directory);
    const db = new DatabaseSync(join(directory, "storage.sqlite"));
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, persistent INTEGER NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, viewport TEXT NOT NULL, proxy_id TEXT,
      storage_state TEXT, owner_key_hash TEXT, live_viewer INTEGER NOT NULL DEFAULT 0
    )`);
    const state = JSON.stringify({ cookies: [], origins: [] });
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)").run(
      "ses_legacy",
      1,
      Date.now(),
      Date.now() + 60000,
      JSON.stringify({ width: 1280, height: 720 }),
      null,
      state,
      "owner",
      0,
    );

    const store = new SessionStore(db, directory, new SecretBox());
    const persisted = db
      .prepare("SELECT storage_state FROM sessions WHERE id=?")
      .get("ses_legacy") as { storage_state: string };
    expect(persisted.storage_state).toMatch(/^v1:/);
    expect(store.get("ses_legacy")?.storageState).toBe(state);
    db.close();
  });
});

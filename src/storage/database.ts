import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import type { SqlRow } from "./types.js";

export type StorageConnection = {
  db: DatabaseSync;
  cacheDir: string;
  artifactsDir: string;
  profilesDir: string;
};

export function openStorage(): StorageConnection {
  mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(join(config.dataDir, "openbrowse.sqlite"));
  const cacheDir = join(config.dataDir, "cache", "sha256");
  const artifactsDir = join(config.dataDir, "artifacts");
  const profilesDir = join(config.dataDir, "profiles");
  db.exec("PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;");
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(`CREATE TABLE IF NOT EXISTS cache_entries (key TEXT PRIMARY KEY, path TEXT NOT NULL, bytes INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_access INTEGER NOT NULL, metadata TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, owner_key_hash TEXT NOT NULL, path TEXT NOT NULL, content_type TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, persistent INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, viewport TEXT NOT NULL, proxy_id TEXT, storage_state TEXT, owner_key_hash TEXT, live_viewer INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS browser_profiles (id TEXT PRIMARY KEY, owner_key_hash TEXT NOT NULL, name TEXT NOT NULL, storage_state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(owner_key_hash, name));
    CREATE TABLE IF NOT EXISTS proxies (id TEXT PRIMARY KEY, owner_key_hash TEXT NOT NULL, name TEXT NOT NULL UNIQUE, secret TEXT NOT NULL, allowed_domains TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, owner_key_hash TEXT NOT NULL, operation TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL, artifact_id TEXT, result TEXT, error TEXT, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS replays (id TEXT PRIMARY KEY, owner_key_hash TEXT NOT NULL, session_id TEXT NOT NULL, artifact_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS session_handoffs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, redeemed_at INTEGER);
    CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, owner_key_hash TEXT NOT NULL, url TEXT NOT NULL, events TEXT NOT NULL, secret TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS request_audit (id TEXT PRIMARY KEY, operation TEXT NOT NULL, status_code INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS usage_counters (key_hash TEXT NOT NULL, day TEXT NOT NULL, requests INTEGER NOT NULL, successful INTEGER NOT NULL, failed INTEGER NOT NULL, PRIMARY KEY(key_hash, day));`);
  const sessionColumns = db
    .prepare("PRAGMA table_info(sessions)")
    .all() as SqlRow[];
  if (
    !sessionColumns.some((column) => String(column.name) === "owner_key_hash")
  )
    db.exec("ALTER TABLE sessions ADD COLUMN owner_key_hash TEXT");
  if (!sessionColumns.some((column) => String(column.name) === "live_viewer"))
    db.exec("ALTER TABLE sessions ADD COLUMN live_viewer INTEGER NOT NULL DEFAULT 0");
  for (const [table, column] of [
    ["artifacts", "owner_key_hash"],
    ["proxies", "owner_key_hash"],
    ["jobs", "owner_key_hash"],
    ["replays", "owner_key_hash"],
    ["webhooks", "owner_key_hash"],
  ] as const) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
    if (!columns.some((value) => String(value.name) === column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
  return { db, cacheDir, artifactsDir, profilesDir };
}

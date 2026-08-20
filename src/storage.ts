import { mkdir, stat } from "node:fs/promises";
import { config } from "./config.js";
import { ArtifactStore } from "./storage/artifacts.js";
import { CacheStore } from "./storage/cache-store.js";
import { SecretBox } from "./storage/crypto.js";
import { openStorage } from "./storage/database.js";
import { JobStore } from "./storage/jobs.js";
import { HandoffStore } from "./storage/handoffs.js";
import { OperationsStore } from "./storage/operations.js";
import { ProxyStore } from "./storage/proxies.js";
import { SessionStore } from "./storage/sessions.js";
import type {
  Artifact,
  StoredBrowserProfile,
  StoredJob,
  StoredProxy,
  StoredReplay,
  StoredSession,
  StoredWebhook,
  UsageSummary,
} from "./storage/types.js";

export type {
  Artifact,
  StoredBrowserProfile,
  StoredJob,
  StoredProxy,
  StoredReplay,
  StoredSession,
  StoredWebhook,
  UsageSummary,
} from "./storage/types.js";

/** Stable persistence facade; each concern is implemented in its own repository. */
export class Storage {
  private readonly connection = openStorage();
  private closed = false;
  private readonly secrets = new SecretBox();
  private readonly cache = new CacheStore(
    this.connection.db,
    this.connection.cacheDir,
  );
  private readonly artifacts = new ArtifactStore(
    this.connection.db,
    this.connection.artifactsDir,
  );
  private readonly sessions = new SessionStore(
    this.connection.db,
    this.connection.profilesDir,
    this.secrets,
  );
  private readonly proxies = new ProxyStore(this.connection.db, this.secrets);
  private readonly jobs = new JobStore(this.connection.db);
  private readonly handoffs = new HandoffStore(this.connection.db);
  private readonly operations = new OperationsStore(
    this.connection.db,
    this.secrets,
  );
  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.connection.cacheDir, { recursive: true }),
      mkdir(this.connection.artifactsDir, { recursive: true }),
      mkdir(this.connection.profilesDir, { recursive: true }),
    ]);
  }
  close(): void {
    if (this.closed) return;
    this.connection.db.close();
    this.closed = true;
  }
  profilePath(id: string): string {
    return this.sessions.profilePath(id);
  }
  getCache(key: string) {
    return this.cache.get(key);
  }
  putCache(
    key: string,
    body: Buffer,
    ttlSeconds: number,
    metadata: Record<string, unknown>,
  ) {
    return this.cache.put(key, body, ttlSeconds, metadata);
  }
  deleteCache(key: string) {
    return this.cache.remove(key);
  }
  purgeCache(value?: string) {
    return this.cache.purge(value);
  }
  cacheStats() {
    return this.cache.stats();
  }
  createArtifact(
    body: Buffer,
    contentType: string,
    ownerKeyHash: string,
    ttlSeconds = 3600,
  ): Promise<Artifact> {
    return this.artifacts.create(body, contentType, ownerKeyHash, ttlSeconds);
  }
  getArtifact(id: string, ownerKeyHash: string) {
    return this.artifacts.get(id, ownerKeyHash);
  }
  createSession(input: Omit<StoredSession, "id" | "createdAt">): StoredSession {
    return this.sessions.create(input);
  }
  getSession(id: string) {
    return this.sessions.get(id);
  }
  listSessions(ownerKeyHash: string) {
    return this.sessions.list(ownerKeyHash);
  }
  updateSessionState(id: string, storageState: string) {
    this.sessions.updateState(id, storageState);
  }
  deleteSession(id: string) {
    this.handoffs.revokeForSession(id);
    return this.sessions.delete(id);
  }
  createSessionHandoff(sessionId: string, ttlSeconds: number) {
    return this.handoffs.create(sessionId, ttlSeconds);
  }
  redeemSessionHandoff(token: string, ownerKeyHash: string) {
    const handoff = this.handoffs.redeem(token);
    if (!handoff) return undefined;
    if (!this.sessions.transferOwner(handoff.sessionId, ownerKeyHash)) return undefined;
    return this.sessions.get(handoff.sessionId);
  }
  createBrowserProfile(input: {
    ownerKeyHash: string;
    name: string;
    storageState: string;
  }): StoredBrowserProfile {
    return this.sessions.createProfile(input);
  }
  getBrowserProfile(id: string, ownerKeyHash: string) {
    return this.sessions.getProfile(id, ownerKeyHash);
  }
  getBrowserProfileByName(name: string, ownerKeyHash: string) {
    return this.sessions.getProfileByName(name, ownerKeyHash);
  }
  listBrowserProfiles(
    ownerKeyHash: string,
  ): Array<Omit<StoredBrowserProfile, "storageState">> {
    return this.sessions.listProfiles(ownerKeyHash);
  }
  deleteBrowserProfile(id: string, ownerKeyHash: string) {
    return this.sessions.deleteProfile(id, ownerKeyHash);
  }
  createProxy(
    name: string,
    url: string,
    allowedDomains: string[],
    ownerKeyHash: string,
  ): Omit<StoredProxy, "url"> {
    return this.proxies.create(name, url, allowedDomains, ownerKeyHash);
  }
  getProxy(id: string, ownerKeyHash: string) {
    return this.proxies.get(id, ownerKeyHash);
  }
  deleteProxy(id: string, ownerKeyHash: string) {
    return this.proxies.delete(id, ownerKeyHash);
  }
  createJob(
    operation: string,
    request: string,
    ttlSeconds: number,
    ownerKeyHash: string,
  ): StoredJob {
    return this.jobs.create(operation, request, ttlSeconds, ownerKeyHash);
  }
  getJob(id: string, ownerKeyHash: string) {
    return this.jobs.get(id, ownerKeyHash);
  }
  updateJob(id: string, ownerKeyHash: string, patch: Partial<StoredJob>) {
    this.jobs.update(id, ownerKeyHash, patch);
  }
  createReplay(
    sessionId: string,
    artifactId: string,
    ttlSeconds: number,
    ownerKeyHash: string,
  ): StoredReplay {
    return this.jobs.createReplay(sessionId, artifactId, ttlSeconds, ownerKeyHash);
  }
  getReplay(id: string, ownerKeyHash: string) {
    return this.jobs.getReplay(id, ownerKeyHash);
  }
  createWebhook(
    url: string,
    events: string[],
    ownerKeyHash: string,
  ): Omit<StoredWebhook, "secret"> & { secret: string } {
    return this.operations.createWebhook(url, events, ownerKeyHash);
  }
  listWebhooks(ownerKeyHash: string) {
    return this.operations.listWebhooks(ownerKeyHash);
  }
  deleteWebhook(id: string, ownerKeyHash: string) {
    return this.operations.deleteWebhook(id, ownerKeyHash);
  }
  audit(id: string, operation: string, statusCode: number) {
    this.operations.audit(id, operation, statusCode);
  }
  reserveUsage(keyHash: string, dailyLimit: number): UsageSummary | undefined {
    return this.operations.reserveUsage(keyHash, dailyLimit);
  }
  recordUsageOutcome(keyHash: string, statusCode: number) {
    this.operations.recordUsageOutcome(keyHash, statusCode);
  }
  getUsage(keyHash: string, day?: string) {
    return this.operations.getUsage(keyHash, day);
  }
  async diskBytes(): Promise<number> {
    try {
      return (await stat(config.dataDir)).size;
    } catch {
      return 0;
    }
  }
}

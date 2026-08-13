import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import { OpenBrowseError } from "../errors.js";
import { SecretBox } from "./crypto.js";
import type { SqlRow, StoredProxy } from "./types.js";

export class ProxyStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly secrets: SecretBox,
  ) {}
  create(
    name: string,
    url: string,
    allowedDomains: string[],
    ownerKeyHash: string,
  ): Omit<StoredProxy, "url"> {
    if (!config.encryptionKey)
      throw new OpenBrowseError(
        "INVALID_REQUEST",
        "OPENBROWSE_ENCRYPTION_KEY is required to persist proxy credentials",
        400,
      );
    const id = `pxy_${randomUUID().replaceAll("-", "")}`;
    const parsed = new URL(url);
    this.db
      .prepare("INSERT INTO proxies(id,owner_key_hash,name,secret,allowed_domains) VALUES(?,?,?,?,?)")
      .run(
        id,
        ownerKeyHash,
        name,
        this.secrets.encrypt(url),
        JSON.stringify(allowedDomains.map((domain) => domain.toLowerCase())),
      );
    return {
      id,
      ownerKeyHash,
      name,
      allowedDomains: [],
      host: parsed.hostname,
      port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
    } as Omit<StoredProxy, "url">;
  }
  get(id: string, ownerKeyHash: string): StoredProxy | undefined {
    const row = this.db.prepare("SELECT * FROM proxies WHERE id=? AND owner_key_hash=?").get(id, ownerKeyHash) as
      | SqlRow
      | undefined;
    return row
      ? {
          id,
          ownerKeyHash,
          name: String(row.name),
          url: this.secrets.decrypt(String(row.secret)),
          allowedDomains: JSON.parse(String(row.allowed_domains)) as string[],
        }
      : undefined;
  }
  delete(id: string, ownerKeyHash: string): boolean {
    return (
      this.db.prepare("DELETE FROM proxies WHERE id=? AND owner_key_hash=?").run(id, ownerKeyHash).changes > 0
    );
  }
}

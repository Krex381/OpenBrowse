import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { config } from "../config.js";
import { OpenBrowseError } from "../errors.js";

export class SecretBox {
  encrypt(value: string): string {
    const iv = randomBytes(12);
    const key = createHash("sha256").update(config.encryptionKey).digest();
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return `v1:${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${encrypted.toString("base64")}`;
  }
  decrypt(value: string): string {
    const [iv, tag, ciphertext] = value.replace(/^v1:/, "").split(".");
    if (!iv || !tag || !ciphertext)
      throw new OpenBrowseError(
        "INTERNAL_ERROR",
        "Stored encrypted secret is malformed",
        500,
      );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      createHash("sha256").update(config.encryptionKey).digest(),
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
}

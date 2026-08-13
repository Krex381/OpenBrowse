import { existsSync, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export function int(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
export function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}
export function externalAddress(): string {
  const raw = process.env.OPENBROWSE_EXTERNAL_URL?.trim();
  if (!raw) return "";
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new Error("OPENBROWSE_EXTERNAL_URL must be an absolute http(s) URL");
  }
  if (
    !/^https?:$/.test(value.protocol) ||
    value.username ||
    value.password ||
    value.search ||
    value.hash
  )
    throw new Error(
      "OPENBROWSE_EXTERNAL_URL must be an http(s) origin with no credentials, query, or fragment",
    );
  return value.toString().replace(/\/$/, "");
}
export function corsOrigins(): ReadonlySet<string> {
  const raw = process.env.OPENBROWSE_CORS_ALLOWED_ORIGINS ?? "";
  if (!raw.trim()) return new Set();
  const origins = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (origins.includes("*") && origins.length > 1)
    throw new Error("OPENBROWSE_CORS_ALLOWED_ORIGINS may use * only by itself");
  for (const origin of origins) {
    if (origin === "*") continue;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(
        "OPENBROWSE_CORS_ALLOWED_ORIGINS must contain absolute origins",
      );
    }
    if (
      !/^https?:$/.test(parsed.protocol) ||
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password
    )
      throw new Error(
        "OPENBROWSE_CORS_ALLOWED_ORIGINS must contain normalized http(s) origins only",
      );
  }
  return new Set(origins);
}
export function extensionDirs(): string[] {
  const raw = process.env.OPENBROWSE_CHROMIUM_EXTENSION_DIRS ?? "";
  if (!raw.trim()) return [];
  return raw
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const directory = resolve(value);
      if (!existsSync(directory) || !statSync(directory).isDirectory())
        throw new Error(
          `OPENBROWSE_CHROMIUM_EXTENSION_DIRS contains a missing directory: ${directory}`,
        );
      return directory;
    });
}

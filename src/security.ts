import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { OpenBrowseError } from "./errors.js";

const blockedHostnames = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);

export function isPrivateIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const parts = address.split(".").map(Number);
    const [a = -1, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b !== undefined && b >= 64 && b <= 127) ||
      a === 198 ||
      a >= 224
    );
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (mappedIpv4) return isPrivateIp(mappedIpv4);
    const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1] ?? "", 16);
      const low = Number.parseInt(mappedHex[2] ?? "", 16);
      return isPrivateIp(
        [high >>> 8, high & 255, low >>> 8, low & 255].join("."),
      );
    }
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    );
  }
  return true;
}

export async function assertSafeUrl(
  value: string,
  allowedDomains?: readonly string[],
): Promise<URL> {
  return (await resolveSafeUrl(value, allowedDomains)).url;
}

export interface SafeUrlResolution {
  url: URL;
  addresses: Array<{ address: string; family: 4 | 6 }>;
}

export async function resolveSafeUrl(
  value: string,
  allowedDomains?: readonly string[],
  resolver: typeof lookup = lookup,
): Promise<SafeUrlResolution> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpenBrowseError("INVALID_URL", "URL is invalid", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new OpenBrowseError(
      "INVALID_URL",
      "Only http and https URLs are allowed",
      400,
    );
  if (url.username || url.password)
    throw new OpenBrowseError(
      "INVALID_URL",
      "Target URLs must not include credentials",
      400,
    );
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (blockedHostnames.has(hostname) || hostname.endsWith(".localhost"))
    throw new OpenBrowseError(
      "SSRF_BLOCKED",
      "Target resolves to a blocked host",
      403,
    );
  if (
    allowedDomains &&
    allowedDomains.length > 0 &&
    !allowedDomains.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    )
  )
    throw new OpenBrowseError(
      "DOMAIN_DENIED",
      "Target host is not allowed by the selected proxy",
      403,
    );
  if (isIP(hostname)) {
    if (isPrivateIp(hostname))
      throw new OpenBrowseError(
        "SSRF_BLOCKED",
        "Private or reserved IP targets are blocked",
        403,
      );
    return { url, addresses: [{ address: hostname, family: isIP(hostname) as 4 | 6 }] };
  }
  let addresses: Awaited<ReturnType<typeof lookup>>[];
  try {
    addresses = await resolver(hostname, { all: true, verbatim: true });
  } catch {
    throw new OpenBrowseError(
      "TARGET_NETWORK_ERROR",
      "Target hostname could not be resolved",
      502,
      true,
    );
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateIp(address))
  )
    throw new OpenBrowseError(
      "SSRF_BLOCKED",
      "Target resolves to a private or reserved IP address",
      403,
    );
  return {
    url,
    addresses: addresses.map(({ address, family }) => ({
      address,
      family: family as 4 | 6,
    })),
  };
}

export function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()])
    if (/^_?_?cf_chl_/i.test(key)) url.searchParams.delete(key);
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  )
    url.port = "";
  return url.toString();
}

export function cacheKey(parts: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

export function constantTimeApiKeyMatch(
  candidate: string,
  keys: ReadonlySet<string>,
): boolean {
  const digest = createHash("sha256").update(candidate).digest();
  return [...keys].some((key) =>
    timingSafeEqual(digest, createHash("sha256").update(key).digest()),
  );
}

export function redactHeaders(
  headers: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) =>
      /authorization|cookie|proxy-authorization/i.test(key)
        ? [key, "[REDACTED]"]
        : [key, value],
    ),
  );
}

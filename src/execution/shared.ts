import { config } from "../config.js";
import type { StoredProxy } from "../storage.js";
import { ProxyAgent } from "undici";

export function timeout(value: number | undefined): number {
  return Math.min(value ?? config.jobTimeoutMs, config.jobTimeoutMs);
}

export function safeHeaders(
  input: Record<string, string> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input ?? {}))
    if (!/^(host|connection|content-length|proxy-authorization)$/i.test(name))
      headers[name] = value;
  return headers;
}

export function proxySettings(proxy: StoredProxy): {
  server: string;
  username?: string;
  password?: string;
} {
  const url = new URL(proxy.url);
  return {
    server: `${url.protocol}//${url.host}`,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

export function defaultProxySettings():
  | { server: string; username?: string; password?: string }
  | undefined {
  if (!config.egressProxyUrl) return undefined;
  const url = new URL(config.egressProxyUrl);
  return {
    server: `${url.protocol}//${url.host}`,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

/**
 * Creates a short-lived dispatcher for non-browser outbound requests. Callers
 * must close the returned agent once their request sequence finishes.
 */
export function egressProxyAgent(): ProxyAgent | undefined {
  return config.egressProxyUrl ? new ProxyAgent(config.egressProxyUrl) : undefined;
}

export function appearsClientRendered(html: string): boolean {
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (
    text.length < 200 &&
    (/<div[^>]+id=["'](?:root|app|__next)["']/i.test(html) ||
      /(?:__NEXT_DATA__|webpack|vite|react)/i.test(html))
  );
}

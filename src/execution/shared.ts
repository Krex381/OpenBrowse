import { config } from "../config.js";
import type { StoredProxy } from "../storage.js";
import { ProxyAgent } from "undici";
import { load } from "cheerio";
import type { ClientRenderAnalysis } from "./types.js";

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

export function analyzeClientRendering(input: {
  html?: string;
  status: number;
  contentType: string;
}): ClientRenderAnalysis {
  const html = input.html ?? "";
  if (!input.contentType.toLowerCase().includes("html"))
    return {
      browserRecommended: false,
      reason: "non-html-response",
      signals: ["content-type-not-html"],
      textChars: 0,
      htmlChars: html.length,
      scriptChars: 0,
      scriptCount: 0,
      meaningfulTextDensity: 0,
    };
  if (input.status === 401 || input.status === 403 || input.status === 404 || input.status >= 500)
    return {
      browserRecommended: false,
      reason: "http-status-terminal",
      signals: [`terminal-http-status:${input.status}`],
      textChars: 0,
      htmlChars: html.length,
      scriptChars: 0,
      scriptCount: 0,
      meaningfulTextDensity: 0,
    };
  const $ = load(html);
  const scripts = $("script").toArray();
  const moduleScripts = $("script[type='module']").length;
  const scriptChars = scripts.reduce(
    (total, script) => total + ($(script).html()?.length ?? 0) + ($(script).attr("src")?.length ?? 0),
    0,
  );
  $("script,style,noscript,template,svg,canvas").remove();
  const text = $.root().text().replace(/\s+/g, " ").trim();
  const textChars = text.length;
  const htmlChars = html.length;
  const density = Number((textChars / Math.max(1, htmlChars)).toFixed(4));
  const signals: string[] = [];
  const emptyRoots = ["#root", "#app", "#__next", "#svelte"]
    .filter((selector) => {
      const node = $(selector).first();
      return node.length > 0 && node.text().trim().length < 40 && node.children().length < 3;
    });
  if (emptyRoots.length) signals.push(`empty-app-root:${emptyRoots.join(",")}`);
  if (moduleScripts > 0 || /<script[^>]+type=["']module["']/i.test(html))
    signals.push("module-script");
  const frameworkMarkers = [
    ["react", /react(?:dom)?|data-reactroot|__REACT_DEVTOOLS_GLOBAL_HOOK__/i],
    ["vite", /\/@vite|vite(?:\/client)?|assets\/index-[\w-]+\.js/i],
    ["next", /__NEXT_DATA__|\/_next\//i],
    ["vue", /data-v-[\da-f]+|__VUE__|vue(?:\.runtime)?/i],
    ["angular", /ng-version|<app-root|zone\.js/i],
    ["svelte", /svelte-[\w-]+|__svelte/i],
  ] as const;
  for (const [name, pattern] of frameworkMarkers)
    if (pattern.test(html)) signals.push(`framework:${name}`);
  if (/<(?:div|section)[^>]+(?:skeleton|loading|spinner|shimmer)/i.test(html))
    signals.push("loading-placeholder");
  if (scripts.length >= 6 && density < 0.03) signals.push("script-heavy-low-text");
  if (textChars < 200) signals.push("minimal-visible-text");
  const structuralShell = emptyRoots.length > 0 && signals.some((value) => value.startsWith("framework:") || value === "module-script");
  const scriptHeavyShell = signals.includes("script-heavy-low-text") && textChars < 500;
  const browserRecommended = structuralShell || scriptHeavyShell || (signals.includes("loading-placeholder") && textChars < 300);
  return {
    browserRecommended,
    reason: browserRecommended ? "client-rendered-shell" : "http-content-sufficient",
    signals,
    textChars,
    htmlChars,
    scriptChars,
    scriptCount: scripts.length,
    meaningfulTextDensity: density,
  };
}

export function appearsClientRendered(html: string): boolean {
  return analyzeClientRendering({ html, status: 200, contentType: "text/html" }).browserRecommended;
}

export function hasAccessChallenge(html: string): boolean {
  return (
    /<title[^>]*>\s*just a moment(?:\.{3})?\s*<\/title>/i.test(html) ||
    /(?:id|class|src)=["'][^"']*(?:captcha|recaptcha|hcaptcha|cf-chl-)[^"']*["']/i.test(html) ||
    /(?:data-sitekey|challenges\.cloudflare\.com\/turnstile)/i.test(html)
  );
}

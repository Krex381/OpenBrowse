import type { StoredProxy } from "../storage.js";

export type Strategy = "auto" | "http" | "quickjs" | "browser";
export type Output = "html" | "markdown" | "links";
export type NavigationWait = "load" | "domcontentloaded" | "networkidle";
export type BrowserWait =
  | { type: "domcontentloaded" }
  | { type: "load" }
  | { type: "networkidle"; timeoutMs?: number }
  | { type: "selector"; selector: string; state?: "attached" | "visible" }
  | { type: "delay"; ms: number }
  | { type: "stability"; quietMs?: number; timeoutMs?: number };

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

export interface FetchInput {
  url: string;
  strategy?: Strategy;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** @deprecated Use `wait` for post-navigation readiness control. */
  waitUntil?: NavigationWait;
  wait?: BrowserWait;
  output?: Output[];
  viewport?: Viewport;
  proxy?: StoredProxy;
}

export interface FetchResult {
  status: number;
  finalUrl: string;
  strategy: "http" | "browser";
  attempted: ("http" | "browser")[];
  contentType: string;
  html?: string;
  markdown?: string;
  links?: string[];
  fetchMs: number;
  browserMs: number;
  networkBytes: number;
}

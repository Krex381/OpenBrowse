import type { StoredProxy } from "../storage.js";

export type Strategy = "auto" | "http" | "quickjs" | "browser";
export type Output = "html" | "markdown" | "links";

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
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
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

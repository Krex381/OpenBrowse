import type { BrowserPool, SessionManager } from "../execution.js";
import type { AdmissionQueue } from "../queue.js";
import type { Storage } from "../storage.js";
import type { Cache } from "../cache.js";
import { createAgentExecutor } from "./core/agent.js";
import { createBqlExecutor } from "./core/bql.js";
import { createFetchService } from "./core/fetch.js";

export type FetchResponse = {
  requestId: string;
  status: number;
  finalUrl: string;
  strategy: "http" | "browser";
  attempted: string[];
  contentType: string;
  html?: string;
  text?: string;
  markdown?: string;
  links?: string[];
  metadata?: import("../execution.js").ArticleMetadata;
  article?: import("../execution.js").ArticleResult;
  provenance?: import("../execution.js").ProvenanceRecord[];
  timings: {
    queueMs: number;
    fetchMs: number;
    httpMs: number;
    browserAcquireMs: number;
    navigationMs: number;
    settleMs: number;
    extractionMs: number;
    browserMs: number;
    totalMs: number;
  };
  execution: import("../execution.js").FetchResult["execution"];
  cache: { hit: boolean; key: string; layer?: string };
  resourceUsage: {
    strategy: string;
    browserMs: number;
    networkBytes: number;
    artifactBytes: number;
    estimatedComputeUnits: number;
  };
};

/** Composes independently testable execution services for the HTTP route plugins. */
export function createExecutionCore(input: {
  storage: Storage;
  cache: Cache;
  queue: AdmissionQueue;
  pool: BrowserPool;
  sessions: SessionManager;
}) {
  const fetch = createFetchService(input);
  const agent = createAgentExecutor({
    storage: input.storage,
    sessions: input.sessions,
    resolveProxy: fetch.resolveProxy,
  });
  const bql = createBqlExecutor({
    sessions: input.sessions,
    resolveProxy: fetch.resolveProxy,
    executeAgentCommand: agent.executeAgentCommand,
  });
  return { ...fetch, ...agent, ...bql };
}

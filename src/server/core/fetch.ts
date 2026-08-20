import {
  adaptiveFetch,
  transform,
  type BrowserPool,
  type FetchInput,
} from "../../execution.js";
import { OpenBrowseError } from "../../errors.js";
import type { AdmissionQueue } from "../../queue.js";
import { assertSafeUrl, cacheKey, normalizeUrl } from "../../security.js";
import type { StoredProxy, Storage } from "../../storage.js";
import type { Cache } from "../../cache.js";
import type { ApiFetch } from "../input.js";
import type { FetchResponse } from "../execution-core.js";
import { recordFetchObservation } from "../../telemetry.js";

export function createFetchService(input: {
  storage: Storage;
  cache: Cache;
  queue: AdmissionQueue;
  pool: BrowserPool;
}) {
  const { storage, cache, queue, pool } = input;
  async function resolveProxy(
    id: string | undefined,
    ownerKeyHash?: string,
  ): Promise<StoredProxy | undefined> {
    if (!id) return undefined;
    if (!ownerKeyHash)
      throw new OpenBrowseError("INVALID_REQUEST", "A proxy requires an authenticated owner", 400);
    const proxy = storage.getProxy(id, ownerKeyHash);
    if (!proxy)
      throw new OpenBrowseError(
        "INVALID_REQUEST",
        "Selected proxy does not exist",
        400,
      );
    return proxy;
  }
  async function runFetch(body: ApiFetch & { ownerKeyHash?: string }): Promise<FetchResponse> {
    const proxy = await resolveProxy(body.proxyId, body.ownerKeyHash);
    const input: FetchInput = {
      url: body.url,
      strategy: body.strategy,
      ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {}),
      ...(body.headers ? { headers: body.headers } : {}),
      ...(body.waitUntil ? { waitUntil: body.waitUntil } : {}),
      ...(body.wait ? { wait: body.wait } : {}),
      ...(body.viewport ? { viewport: body.viewport } : {}),
      ...(body.browserBackend ? { browserBackend: body.browserBackend } : {}),
      ...(body.browserOptions ? { browserOptions: body.browserOptions } : {}),
      ...(proxy ? { proxy } : {}),
    };
    await assertSafeUrl(body.url, proxy?.allowedDomains);
    const key = cacheKey({
      url: normalizeUrl(body.url),
      strategy: body.strategy,
      output: body.output,
      viewport: body.viewport,
      headers: body.headers ?? {},
      waitUntil: body.waitUntil,
      wait: body.wait,
      browserBackend: body.browserBackend,
      browserOptions: body.browserOptions,
    });
    const cacheable =
      body.cache.mode === "default" &&
      !Object.keys(body.headers ?? {}).some((header) =>
        /authorization|cookie/i.test(header),
      );
    if (cacheable) {
      const hit = await cache.get(key);
      if (hit) {
        const response = JSON.parse(hit.body.toString("utf8")) as FetchResponse;
        if (response.execution.challengeRemaining) await cache.delete(key);
        else {
          recordFetchObservation({
            cacheHit: true,
            strategy: response.strategy,
            plannerReason: response.execution.plan.reason,
            ...(response.execution.selectedBackend
              ? { backend: response.execution.selectedBackend }
              : {}),
          });
          return { ...response, cache: { hit: true, key, layer: hit.layer } };
        }
      }
    }
    const compute = async () => {
      const totalStarted = Date.now();
      const scheduled = await queue.run(
        () => adaptiveFetch(pool, input),
        input.strategy === "browser" ? "browser" : "http",
      );
      const result = scheduled.result;
      const resultCacheable =
        cacheable && result.execution.challengeRemaining !== true;
      result.execution.plan.cacheEligible = resultCacheable;
      result.execution.plan.cacheEligibility = {
        eligible: resultCacheable,
        reason:
          result.execution.challengeRemaining
            ? "challenge-response"
            : cacheable
            ? "public-request"
            : body.cache.mode !== "default"
            ? "caller-disabled"
            : "private-request-headers",
      };
      const response = {
        requestId: "",
        status: result.status,
        finalUrl: result.finalUrl,
        strategy: result.strategy,
        attempted: result.attempted,
        contentType: result.contentType,
        ...transform(result, body.output),
        timings: {
          queueMs: scheduled.queueMs,
          fetchMs: result.fetchMs,
          httpMs: result.execution.timings.httpMs,
          browserAcquireMs: result.execution.timings.browserAcquireMs,
          navigationMs: result.execution.timings.navigationMs,
          settleMs: result.execution.timings.settleMs,
          extractionMs: result.execution.timings.extractionMs,
          browserMs: result.execution.timings.browserMs,
          totalMs: Date.now() - totalStarted,
        },
        execution: result.execution,
        cache: { hit: false, key },
        resourceUsage: {
          strategy: result.strategy,
          browserMs: result.browserMs,
          networkBytes: result.networkBytes,
          artifactBytes: 0,
          estimatedComputeUnits: Math.max(
            1,
            Math.ceil((result.browserMs + result.fetchMs) / 100),
          ),
        },
      };
      recordFetchObservation({
        cacheHit: false,
        strategy: result.strategy,
        plannerReason: result.execution.plan.reason,
        ...(result.execution.selectedBackend
          ? { backend: result.execution.selectedBackend }
          : {}),
      });
      if (resultCacheable)
        await cache.put(
          key,
          Buffer.from(JSON.stringify(response)),
          body.cache.ttlSeconds,
          { url: normalizeUrl(body.url) },
        );
      return response;
    };
    return cacheable ? cache.coalesce(key, compute) : compute();
  }

  return { resolveProxy, runFetch };
}

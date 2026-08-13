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
      ...(body.viewport ? { viewport: body.viewport } : {}),
      ...(proxy ? { proxy } : {}),
    };
    await assertSafeUrl(body.url, proxy?.allowedDomains);
    const key = cacheKey({
      url: normalizeUrl(body.url),
      strategy: body.strategy,
      output: body.output,
      viewport: body.viewport,
      headers: body.headers ?? {},
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
        return { ...response, cache: { hit: true, key, layer: hit.layer } };
      }
    }
    const compute = async () => {
      const totalStarted = Date.now();
      const scheduled = await queue.run(
        () => adaptiveFetch(pool, input),
        input.strategy === "http" ? "http" : "browser",
      );
      const result = scheduled.result;
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
          totalMs: Date.now() - totalStarted,
        },
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
      if (cacheable)
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

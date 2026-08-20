import { Agent, fetch as undiciFetch, ProxyAgent } from "undici";
import type { LookupFunction } from "node:net";
import { config } from "../config.js";
import { OpenBrowseError } from "../errors.js";
import { normalizeUrl, resolveSafeUrl } from "../security.js";
import type { FetchInput, FetchResult } from "./types.js";
import { safeHeaders, timeout } from "./shared.js";
import { planExecution } from "./planner.js";

export async function readBoundedResponse(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > config.maxResponseBytes)
    throw new OpenBrowseError(
      "PAYLOAD_TOO_LARGE",
      "Target response exceeds the configured byte limit",
      413,
    );
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > config.maxResponseBytes) {
      await reader.cancel();
      throw new OpenBrowseError(
        "PAYLOAD_TOO_LARGE",
        "Target response exceeds the configured byte limit",
        413,
      );
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}

export async function httpFetch(
  input: FetchInput,
): Promise<Omit<FetchResult, "strategy" | "attempted" | "browserMs">> {
  const started = Date.now();
  let resolution = await resolveSafeUrl(input.url, input.proxy?.allowedDomains);
  let current = resolution.url;
  let response: Response | undefined;
  const proxyAgent = input.proxy || config.egressProxyUrl
    ? new ProxyAgent(input.proxy?.url ?? config.egressProxyUrl)
    : undefined;
  const directAgents: Agent[] = [];
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      try {
        const dispatcher = proxyAgent ?? pinnedAgent(resolution.addresses);
        if (dispatcher instanceof Agent) directAgents.push(dispatcher);
        response = await undiciFetch(current, {
          headers: safeHeaders(input.headers),
          redirect: "manual",
          signal: AbortSignal.timeout(timeout(input.timeoutMs)),
          dispatcher,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError")
          throw new OpenBrowseError(
            "TARGET_TIMEOUT",
            `Target did not complete within ${timeout(input.timeoutMs)}ms`,
            408,
            true,
          );
        throw new OpenBrowseError(
          "TARGET_NETWORK_ERROR",
          "Could not fetch target",
          502,
          true,
        );
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) break;
      await response.body?.cancel();
      if (redirects === 5)
        throw new OpenBrowseError(
          "TARGET_NETWORK_ERROR",
          "Target exceeded the redirect limit",
          502,
        );
      resolution = await resolveSafeUrl(
        new URL(location, current).toString(),
        input.proxy?.allowedDomains,
      );
      current = resolution.url;
    }
    if (!response)
      throw new OpenBrowseError(
        "TARGET_NETWORK_ERROR",
        "Target returned no response",
        502,
        true,
      );
    const body = await readBoundedResponse(response);
    const contentType =
      response.headers.get("content-type") ?? "application/octet-stream";
    return {
      sourceUrl: normalizeUrl(input.url),
      status: response.status,
      finalUrl: normalizeUrl(response.url || current.toString()),
      contentType,
      ...(contentType.includes("html") ? { html: body.toString("utf8") } : {}),
      fetchMs: Date.now() - started,
      networkBytes: body.length,
      execution: {
        plan: planExecution(input),
        backendAttempts: [],
        timings: {
          httpMs: Date.now() - started,
          browserAcquireMs: 0,
          navigationMs: 0,
          settleMs: 0,
          extractionMs: 0,
          browserMs: 0,
        },
        strategyRequested: input.strategy ?? "auto",
        strategyUsed: "http",
        escalated: false,
        timeline: [
          { atMs: 0, event: "accepted" },
          { atMs: 0, event: "http-started" },
          {
            atMs: Date.now() - started,
            event: "http-completed",
            detail: `status:${response.status}`,
          },
        ],
      },
    };
  } finally {
    await proxyAgent?.close();
    await Promise.all(directAgents.map((agent) => agent.close()));
  }
}

export function pinnedAgent(addresses: Array<{ address: string; family: 4 | 6 }>): Agent {
  const lookup: LookupFunction = ((_hostname, options, callback) => {
    const selected = addresses[0];
    if (!selected) {
      callback(new Error("Validated target has no pinned address"), "", 4);
      return;
    }
    if (typeof options === "object" && options.all) {
      callback(null, addresses);
      return;
    }
    callback(null, selected.address, selected.family);
  }) as LookupFunction;
  return new Agent({ connect: { lookup } });
}

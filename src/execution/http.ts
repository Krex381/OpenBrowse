import { fetch as undiciFetch, ProxyAgent } from "undici";
import { config } from "../config.js";
import { OpenBrowseError } from "../errors.js";
import { assertSafeUrl, normalizeUrl } from "../security.js";
import type { FetchInput, FetchResult } from "./types.js";
import { safeHeaders, timeout } from "./shared.js";

async function readBounded(response: Response): Promise<Buffer> {
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
  let current = await assertSafeUrl(input.url, input.proxy?.allowedDomains);
  let response: Response | undefined;
  const proxyAgent = input.proxy || config.egressProxyUrl
    ? new ProxyAgent(input.proxy?.url ?? config.egressProxyUrl)
    : undefined;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      try {
        response = await undiciFetch(current, {
          headers: safeHeaders(input.headers),
          redirect: "manual",
          signal: AbortSignal.timeout(timeout(input.timeoutMs)),
          ...(proxyAgent ? { dispatcher: proxyAgent } : {}),
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
      if (redirects === 5)
        throw new OpenBrowseError(
          "TARGET_NETWORK_ERROR",
          "Target exceeded the redirect limit",
          502,
        );
      current = await assertSafeUrl(
        new URL(location, current).toString(),
        input.proxy?.allowedDomains,
      );
    }
    if (!response)
      throw new OpenBrowseError(
        "TARGET_NETWORK_ERROR",
        "Target returned no response",
        502,
        true,
      );
    const body = await readBounded(response);
    const contentType =
      response.headers.get("content-type") ?? "application/octet-stream";
    return {
      status: response.status,
      finalUrl: normalizeUrl(response.url || current.toString()),
      contentType,
      ...(contentType.includes("html") ? { html: body.toString("utf8") } : {}),
      fetchMs: Date.now() - started,
      networkBytes: body.length,
    };
  } finally {
    await proxyAgent?.close();
  }
}

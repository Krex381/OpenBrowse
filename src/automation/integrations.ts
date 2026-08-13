import { createHmac } from "node:crypto";
import { fetch as undiciFetch } from "undici";
import { egressProxyAgent } from "../execution/shared.js";
import { OpenBrowseError } from "../errors.js";
import { assertSafeUrl } from "../security.js";
import { Storage } from "../storage.js";

export async function dispatchWebhooks(
  storage: Storage,
  ownerKeyHash: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  const dispatcher = egressProxyAgent();
  try {
    await Promise.allSettled(
      storage
        .listWebhooks(ownerKeyHash)
        .filter(
          (webhook) =>
            webhook.events.includes(event) || webhook.events.includes("*"),
        )
        .map(async (webhook) => {
          await assertSafeUrl(webhook.url);
          const payload = JSON.stringify({
            event,
            occurredAt: new Date().toISOString(),
            data,
          });
          await undiciFetch(webhook.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-openbrowse-event": event,
              "x-openbrowse-signature": `sha256=${createHmac("sha256", webhook.secret).update(payload).digest("hex")}`,
            },
            body: payload,
            signal: AbortSignal.timeout(5000),
            ...(dispatcher ? { dispatcher } : {}),
          });
        }),
    );
  } finally {
    await dispatcher?.close();
  }
}

export async function searchWeb(
  endpoint: string,
  query: string,
  categories: string,
  limit: number,
): Promise<Array<{ title: string; url: string; content: string }>> {
  if (!endpoint)
    throw new OpenBrowseError(
      "UNSUPPORTED_FEATURE",
      "Search needs an operator-configured OPENBROWSE_SEARCH_ENDPOINT (SearXNG-compatible JSON API)",
      501,
    );
  const searchUrl = new URL(endpoint);
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("format", "json");
  if (categories) searchUrl.searchParams.set("categories", categories);
  const dispatcher = egressProxyAgent();
  try {
    let response: Response;
    try {
      response = await undiciFetch(searchUrl, {
        signal: AbortSignal.timeout(10000),
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch {
      throw new OpenBrowseError(
        "TARGET_NETWORK_ERROR",
        "Configured search provider could not be reached",
        502,
        true,
      );
    }
    if (!response.ok)
      throw new OpenBrowseError(
        "TARGET_NETWORK_ERROR",
        `Search provider returned HTTP ${response.status}`,
        502,
        true,
      );
    const body = (await response.json()) as { results?: unknown[] };
    if (!Array.isArray(body.results))
      throw new OpenBrowseError(
        "TARGET_NETWORK_ERROR",
        "Search provider returned an invalid JSON response",
        502,
      );
    return body.results.slice(0, limit).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const result = item as {
        title?: unknown;
        url?: unknown;
        content?: unknown;
      };
      return typeof result.title === "string" && typeof result.url === "string"
        ? [
            {
              title: result.title,
              url: result.url,
              content: typeof result.content === "string" ? result.content : "",
            },
          ]
        : [];
    });
  } finally {
    await dispatcher?.close();
  }
}

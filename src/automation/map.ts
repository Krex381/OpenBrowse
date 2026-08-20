import { ZipFile } from "yazl";
import { load } from "cheerio";
import { Agent, fetch as undiciFetch } from "undici";
import { adaptiveFetch, BrowserPool, type FetchInput } from "../execution.js";
import { pinnedAgent, readBoundedResponse } from "../execution/http.js";
import { egressProxyAgent } from "../execution/shared.js";
import { OpenBrowseError } from "../errors.js";
import { assertSafeUrl, normalizeUrl, resolveSafeUrl } from "../security.js";

export interface MapOptions {
  maxUrls?: number;
  maxDepth?: number;
  include?: string[];
  exclude?: string[];
  search?: string;
  render?: "auto" | "http" | "browser";
}
export interface MappedUrl {
  url: string;
  depth: number;
  source: "seed" | "link" | "rendered-link" | "interactive-view";
  control?: { role: "tab" | "link"; label?: string };
}
const unsafeAction = /\b(?:buy|checkout|delete|remove|logout|log\s*out|pay|purchase|submit|confirm|unsubscribe|cancel\s+account)\b/i;
const globMatches = (url: string, pattern: string): boolean => {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "u").test(url);
};
const matches = (url: string, patterns: string[] | undefined): boolean =>
  !patterns || patterns.length === 0 || patterns.some((pattern) => globMatches(url, pattern));

export async function mapSite(
  pool: BrowserPool,
  url: string,
  options: MapOptions = {},
): Promise<MappedUrl[]> {
  const origin = new URL(url).origin;
  const maximum = Math.min(options.maxUrls ?? 100, 1000);
  const maxDepth = Math.min(options.maxDepth ?? 2, 10);
  const seen = new Set<string>();
  const results: MappedUrl[] = [];
  const pending: MappedUrl[] = [
    { url: normalizeUrl(url), depth: 0, source: "seed" },
  ];
  while (pending.length > 0 && results.length < maximum) {
    const current = pending.shift();
    if (!current || seen.has(current.url)) continue;
    seen.add(current.url);
    await assertSafeUrl(current.url);
    if (
      !matches(current.url, options.include) ||
      (options.exclude?.some((pattern) => globMatches(current.url, pattern)) ??
        false)
    )
      continue;
    results.push(current);
    if (current.depth >= maxDepth) continue;
    const result = await adaptiveFetch(pool, {
      url: current.url,
      strategy: options.render ?? "auto",
      timeoutMs: 10000,
    });
    if (!result.html) continue;
    const $ = load(result.html);
    $("a[href],[data-href]").each((_index, element) => {
      const href = $(element).attr("href") ?? $(element).attr("data-href");
      if (!href) return;
      try {
        const next = new URL(href, current.url);
        next.hash = "";
        if (
          next.origin === origin &&
          /^https?:$/.test(next.protocol) &&
          !seen.has(next.toString())
        )
          pending.push({
            url: normalizeUrl(next.toString()),
            depth: current.depth + 1,
            source: result.strategy === "browser" ? "rendered-link" : "link",
          });
      } catch {
        /* invalid links are intentionally ignored */
      }
    });
    $("[role='tab'][aria-controls],[role='link'][data-href],button[data-href]").each(
      (_index, element) => {
        if (results.length >= maximum) return false;
        const label = cleanControlLabel(
          $(element).attr("aria-label") ?? $(element).text(),
        );
        if (unsafeAction.test(label)) return;
        const role = $(element).attr("role") === "tab" ? "tab" : "link";
        const dataHref = $(element).attr("data-href");
        if (dataHref) {
          try {
            const next = new URL(dataHref, current.url);
            if (next.origin === origin && /^https?:$/.test(next.protocol))
              pending.push({
                url: normalizeUrl(next.toString()),
                depth: current.depth + 1,
                source: "rendered-link",
                control: { role, ...(label ? { label } : {}) },
              });
          } catch {
            /* malformed client route is ignored */
          }
          return;
        }
        const controlled = $(element).attr("aria-controls");
        if (!controlled || !/^[-_a-zA-Z0-9:.]+$/.test(controlled)) return;
        const viewUrl = `${current.url.split("#", 1)[0]}#${controlled}`;
        const key = `view:${viewUrl}`;
        if (seen.has(key)) return;
        seen.add(key);
        results.push({
          url: viewUrl,
          depth: current.depth,
          source: "interactive-view",
          control: { role: "tab", ...(label ? { label } : {}) },
        });
      },
    );
  }
  return options.search
    ? results.filter((item) =>
        item.url.toLowerCase().includes(options.search!.toLowerCase()),
      )
    : results;
}

function cleanControlLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 160);
}

export async function exportUrl(
  input: FetchInput & { includeResources?: boolean },
): Promise<{ body: Buffer; contentType: string; finalUrl: string }> {
  const fetched = await safeNativeFetch(input.url, input.timeoutMs ?? 30000);
  if (!input.includeResources || !fetched.contentType.includes("html"))
    return fetched;
  const zip = new ZipFile();
  const buffers: Buffer[] = [];
  const complete = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("data", (chunk: Buffer) => buffers.push(chunk));
    zip.outputStream.once("error", reject);
    zip.outputStream.once("end", () => resolve(Buffer.concat(buffers)));
  });
  zip.addBuffer(fetched.body, "index.html");
  const $ = load(fetched.body.toString("utf8"));
  const origin = new URL(fetched.finalUrl).origin;
  const resources = new Set<string>();
  $("img[src],script[src],link[href]").each((_index, element) => {
    const attribute = element.tagName === "link" ? "href" : "src";
    const value = $(element).attr(attribute);
    if (!value) return;
    try {
      const target = new URL(value, fetched.finalUrl);
      if (target.origin === origin && /^https?:$/.test(target.protocol))
        resources.add(target.toString());
    } catch {
      /* malformed URLs are ignored */
    }
  });
  const manifest: Array<{ url: string; path?: string; error?: string }> = [];
  for (const resource of [...resources].slice(0, 50)) {
    try {
      const item = await safeNativeFetch(resource, input.timeoutMs ?? 30000);
      if (item.body.length > 2 * 1024 * 1024) {
        manifest.push({
          url: resource,
          error: "resource exceeds 2 MiB bundle limit",
        });
        continue;
      }
      const path = `resources/${encodeURIComponent(new URL(resource).pathname.replace(/^\/+/, "") || "index")}`;
      zip.addBuffer(item.body, path);
      manifest.push({ url: resource, path });
    } catch (error) {
      manifest.push({
        url: resource,
        error: error instanceof Error ? error.message : "fetch failed",
      });
    }
  }
  zip.addBuffer(
    Buffer.from(
      JSON.stringify(
        { source: fetched.finalUrl, resources: manifest },
        null,
        2,
      ),
    ),
    "manifest.json",
  );
  zip.end();
  return {
    body: await complete,
    contentType: "application/zip",
    finalUrl: fetched.finalUrl,
  };
}

async function safeNativeFetch(
  value: string,
  timeoutMs: number,
): Promise<{ body: Buffer; contentType: string; finalUrl: string }> {
  let resolution = await resolveSafeUrl(value);
  let target = resolution.url;
  let response: Response | undefined;
  const proxyAgent = egressProxyAgent();
  const directAgents: Agent[] = [];
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      try {
        const dispatcher = proxyAgent ?? pinnedAgent(resolution.addresses);
        if (dispatcher instanceof Agent) directAgents.push(dispatcher);
        response = await undiciFetch(target, {
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
          dispatcher,
        });
      } catch {
        throw new OpenBrowseError(
          "TARGET_NETWORK_ERROR",
          "Could not export target",
          502,
          true,
        );
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location || redirects === 5)
        throw new OpenBrowseError(
          "TARGET_NETWORK_ERROR",
          "Target exceeded the redirect limit",
          502,
        );
      await response.body?.cancel();
      resolution = await resolveSafeUrl(new URL(location, target).toString());
      target = resolution.url;
    }
    if (!response?.ok)
      throw new OpenBrowseError(
        "TARGET_NETWORK_ERROR",
        `Target returned HTTP ${response?.status ?? 0}`,
        502,
        true,
      );
    const body = await readBoundedResponse(response);
    return {
      body,
      contentType:
        response.headers.get("content-type") ?? "application/octet-stream",
      finalUrl: normalizeUrl(response.url || target.toString()),
    };
  } finally {
    await proxyAgent?.close();
    await Promise.all(directAgents.map((agent) => agent.close()));
  }
}

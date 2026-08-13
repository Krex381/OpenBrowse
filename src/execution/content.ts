import { load } from "cheerio";
import { OpenBrowseError } from "../errors.js";
import { assertSafeUrl, normalizeUrl } from "../security.js";
import { httpFetch } from "./http.js";
import { BrowserPool } from "./pool.js";
import { appearsClientRendered, timeout } from "./shared.js";
import type { FetchInput, FetchResult, Output } from "./types.js";

export async function browserFetch(
  pool: BrowserPool,
  input: FetchInput,
): Promise<Omit<FetchResult, "strategy" | "attempted" | "fetchMs">> {
  const started = Date.now();
  await assertSafeUrl(input.url, input.proxy?.allowedDomains);
  return pool
    .withContext(input.viewport, input.proxy, async (_context, page) => {
      page.setDefaultNavigationTimeout(timeout(input.timeoutMs));
      const response = await page.goto(input.url, {
        waitUntil: input.waitUntil ?? "domcontentloaded",
      });
      const html = await page.content();
      const finalUrl = normalizeUrl(page.url());
      if (/captcha|recaptcha|hcaptcha|cf-chl-/i.test(html))
        throw new OpenBrowseError(
          "CAPTCHA_DETECTED",
          "A challenge was detected and the configured policy is fail",
          423,
        );
      return {
        status: response?.status() ?? 200,
        finalUrl,
        contentType: response?.headers()["content-type"] ?? "text/html",
        html,
        browserMs: Date.now() - started,
        networkBytes: Buffer.byteLength(html),
      };
    })
    .catch((error: unknown) => {
      if (error instanceof OpenBrowseError) throw error;
      if (error instanceof Error && /Timeout/i.test(error.message))
        throw new OpenBrowseError(
          "TARGET_TIMEOUT",
          `Target did not complete within ${timeout(input.timeoutMs)}ms`,
          408,
          true,
        );
      throw new OpenBrowseError(
        "RENDER_FAILED",
        "Browser rendering failed",
        422,
        true,
      );
    });
}

export async function adaptiveFetch(
  pool: BrowserPool,
  input: FetchInput,
): Promise<FetchResult> {
  const strategy = input.strategy ?? "auto";
  if (strategy === "browser" || strategy === "quickjs") {
    const browser = await browserFetch(pool, input);
    return {
      ...browser,
      strategy: "browser",
      attempted: ["browser"],
      fetchMs: 0,
    };
  }
  const http = await httpFetch(input);
  if (strategy === "http" || !http.html || !appearsClientRendered(http.html))
    return { ...http, strategy: "http", attempted: ["http"], browserMs: 0 };
  const browser = await browserFetch(pool, input);
  return {
    ...browser,
    strategy: "browser",
    attempted: ["http", "browser"],
    fetchMs: http.fetchMs,
  };
}

export function transform(
  result: FetchResult,
  outputs: Output[],
): Pick<FetchResult, "html" | "markdown" | "links"> {
  if (!result.html) return {};
  const $ = load(result.html);
  $("script,style,noscript,template").remove();
  const answer: Pick<FetchResult, "html" | "markdown" | "links"> = {};
  if (outputs.includes("html")) answer.html = result.html;
  if (outputs.includes("markdown"))
    answer.markdown = $("body")
      .text()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n\n");
  if (outputs.includes("links"))
    answer.links = $("a[href]")
      .map((_index, element) => {
        try {
          return new URL(
            $(element).attr("href") ?? "",
            result.finalUrl,
          ).toString();
        } catch {
          return undefined;
        }
      })
      .get()
      .filter((value): value is string => Boolean(value));
  return answer;
}

export function extract(
  html: string,
  finalUrl: string,
  selectors: Record<
    string,
    {
      selector: string;
      type: "text" | "html" | "attribute";
      attribute?: string;
      all?: boolean;
    }
  >,
): Record<string, unknown> {
  const $ = load(html);
  const data: Record<string, unknown> = {};
  for (const [name, rule] of Object.entries(selectors)) {
    let nodes: ReturnType<typeof $>;
    try {
      nodes = $(rule.selector);
    } catch {
      throw new OpenBrowseError(
        "INVALID_REQUEST",
        `Invalid selector for '${name}'`,
        400,
      );
    }
    const values = nodes
      .map((_index, element) => {
        const value =
          rule.type === "text"
            ? $(element).text().trim()
            : rule.type === "html"
              ? ($(element).html() ?? "")
              : ($(element).attr(rule.attribute ?? "") ?? "");
        if (rule.type === "attribute" && rule.attribute === "href") {
          try {
            return new URL(value, finalUrl).toString();
          } catch {
            return value;
          }
        }
        return value;
      })
      .get();
    data[name] = rule.all ? values : (values[0] ?? null);
  }
  return data;
}

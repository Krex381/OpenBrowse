import { load } from "cheerio";
import { OpenBrowseError } from "../errors.js";
import { assertSafeUrl, normalizeUrl } from "../security.js";
import { httpFetch } from "./http.js";
import { htmlToMarkdown } from "./markdown.js";
import { BrowserPool } from "./pool.js";
import { appearsClientRendered, timeout } from "./shared.js";
import type { BrowserWait, FetchInput, FetchResult, Output } from "./types.js";

const defaultStabilityWait: Required<Extract<BrowserWait, { type: "stability" }>> = {
  type: "stability",
  quietMs: 600,
  timeoutMs: 4_000,
};
const defaultStabilityObservationMs = 1_500;

type ReadyPage = Pick<
  import("playwright").Page,
  "evaluate" | "locator" | "waitForLoadState" | "waitForTimeout"
>;
type BrowserMutationObserver = {
  observe(target: unknown, options: Record<string, boolean>): void;
  disconnect(): void;
};
type BrowserGlobals = {
  document: { documentElement: unknown };
  MutationObserver: new (
    callback: (
      records: Array<{
        type: string;
        addedNodes?: ArrayLike<{ nodeType: number; textContent?: string | null }>;
        removedNodes?: ArrayLike<{ nodeType: number; textContent?: string | null }>;
      }>,
    ) => void,
  ) => BrowserMutationObserver;
  setTimeout: (handler: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
};

/**
 * Waits for a post-navigation readiness signal. The stability implementation
 * observes meaningful DOM changes rather than relying on network idle, which
 * is unreliable for pages with analytics, polling, and WebSockets.
 */
export async function waitForBrowserReadiness(
  page: ReadyPage,
  wait: BrowserWait,
  options: { minimumObservationMs?: number } = {},
): Promise<void> {
  if (wait.type === "domcontentloaded" || wait.type === "load") {
    await page.waitForLoadState(wait.type);
    return;
  }
  if (wait.type === "networkidle") {
    await page.waitForLoadState("networkidle", { timeout: wait.timeoutMs });
    return;
  }
  if (wait.type === "selector") {
    await page.locator(wait.selector).waitFor({ state: wait.state ?? "visible" });
    return;
  }
  if (wait.type === "delay") {
    await page.waitForTimeout(wait.ms);
    return;
  }
  const quietMs = wait.quietMs ?? defaultStabilityWait.quietMs;
  const timeoutMs = Math.max(quietMs, wait.timeoutMs ?? defaultStabilityWait.timeoutMs);
  const minimumObservationMs = Math.min(options.minimumObservationMs ?? 0, timeoutMs);
  await page.evaluate(
    ({ quietMs: quiet, timeoutMs: maximum, minimumObservationMs: observation }) =>
      new Promise<void>((resolve) => {
      const browser = globalThis as unknown as BrowserGlobals;
      let complete = false;
      let observationComplete = observation === 0;
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      let maximumTimer: ReturnType<typeof setTimeout> | undefined;
      let observationTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (complete) return;
        complete = true;
        if (quietTimer) browser.clearTimeout(quietTimer);
        if (maximumTimer) browser.clearTimeout(maximumTimer);
        if (observationTimer) browser.clearTimeout(observationTimer);
        observer.disconnect();
        resolve();
      };
      const resetQuietTimer = () => {
        if (quietTimer) browser.clearTimeout(quietTimer);
        quietTimer = browser.setTimeout(() => {
          if (observationComplete) finish();
        }, quiet);
      };
      const observer = new browser.MutationObserver((records) => {
        const meaningful = records.some((record) => {
          if (record.type !== "childList") return false;
          const nodes = [
            ...Array.from(record.addedNodes ?? []),
            ...Array.from(record.removedNodes ?? []),
          ];
          return nodes.some(
            (node) =>
              node.nodeType === 1 || (node.textContent?.trim().length ?? 0) >= 80,
          );
        });
        if (meaningful)
          resetQuietTimer();
      });
      observer.observe(browser.document.documentElement, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      maximumTimer = browser.setTimeout(finish, maximum);
      if (!observationComplete)
        observationTimer = browser.setTimeout(() => {
          observationComplete = true;
          resetQuietTimer();
        }, observation);
      resetQuietTimer();
    }),
    { quietMs, timeoutMs, minimumObservationMs },
  );
}

function renderWait(
  input: FetchInput,
  defaultStability: boolean,
): BrowserWait | undefined {
  if (input.wait) return input.wait;
  if (input.waitUntil || !defaultStability) return undefined;
  const budget = timeout(input.timeoutMs);
  return {
    ...defaultStabilityWait,
    quietMs: Math.min(defaultStabilityWait.quietMs, budget),
    timeoutMs: Math.min(defaultStabilityWait.timeoutMs, budget),
  };
}

export async function browserFetch(
  pool: BrowserPool,
  input: FetchInput,
  options: { defaultStability?: boolean } = {},
): Promise<Omit<FetchResult, "strategy" | "attempted" | "fetchMs">> {
  const started = Date.now();
  await assertSafeUrl(input.url, input.proxy?.allowedDomains);
  return pool
    .withContext(input.viewport, input.proxy, async (_context, page) => {
      page.setDefaultNavigationTimeout(timeout(input.timeoutMs));
      page.setDefaultTimeout(timeout(input.timeoutMs));
      const response = await page.goto(input.url, {
        waitUntil: input.waitUntil ?? "domcontentloaded",
      });
      const wait = renderWait(input, options.defaultStability ?? false);
      if (wait)
        await waitForBrowserReadiness(page, wait, {
          minimumObservationMs:
            !input.wait && !input.waitUntil && options.defaultStability
              ? defaultStabilityObservationMs
              : 0,
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
  const browser = await browserFetch(pool, input, { defaultStability: true });
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
    answer.markdown = htmlToMarkdown(result.html, result.finalUrl);
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

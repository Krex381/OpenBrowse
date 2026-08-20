import { load } from "cheerio";
import { OpenBrowseError } from "../errors.js";
import { assertSafeUrl, normalizeUrl } from "../security.js";
import { httpFetch } from "./http.js";
import { readableContentHtml } from "./markdown.js";
import { BrowserPool } from "./pool.js";
import { analyzeClientRendering, hasAccessChallenge, timeout } from "./shared.js";
import { extractArticle } from "./article.js";
import { DomainObservationStore } from "./domain-observations.js";
import { planExecution, resolvedPlan } from "./planner.js";
import {
  browserBackendCapability,
  camoufoxFirefoxCapabilities,
  clearcoteChromiumCapabilities,
  cloakBrowserChromiumCapabilities,
  patchrightChromiumCapabilities,
  playwrightChromiumCapabilities,
  selectBrowserBackend,
  type BrowserBackend,
  type BrowserBackendDecision,
} from "./backends.js";
import { resolvedCamoufoxOptions } from "./browser-launchers.js";
import type {
  BrowserWait,
  ExecutionTimelineEvent,
  FetchInput,
  FetchResult,
  Output,
  BrowserBackendId,
} from "./types.js";
import { config } from "../config.js";
import { runChallengeFallback } from "./challenge-fallback.js";

const defaultStabilityWait: Required<Extract<BrowserWait, { type: "stability" }>> = {
  type: "stability",
  quietMs: 600,
  timeoutMs: 4_000,
};
const defaultStabilityObservationMs = 1_500;
const domainObservations = new DomainObservationStore();

type ReadyPage = Pick<
  import("playwright").Page,
  "evaluate" | "locator" | "waitForLoadState" | "waitForTimeout"
>;
type ChallengePage = Pick<
  import("playwright").Page,
  "content" | "waitForTimeout"
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

/** Allows a bounded non-interactive challenge to finish without clicking or looping. */
export async function observeChallengeResolution(
  page: ChallengePage,
  initialHtml: string,
  maxWaitMs: number,
): Promise<{ html: string; waitedMs: number; resolved: boolean }> {
  if (!hasAccessChallenge(initialHtml) || maxWaitMs <= 0)
    return { html: initialHtml, waitedMs: 0, resolved: true };
  const started = Date.now();
  let html = initialHtml;
  while (Date.now() - started < maxWaitMs) {
    await page.waitForTimeout(Math.min(500, maxWaitMs - (Date.now() - started)));
    html = await page.content();
    if (!hasAccessChallenge(html))
      return { html, waitedMs: Date.now() - started, resolved: true };
  }
  return { html, waitedMs: Date.now() - started, resolved: false };
}

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
  const backend = input.browserBackend ?? config.defaultBrowserBackend;
  await assertSafeUrl(input.url, input.proxy?.allowedDomains);
  return pool
    .withContext(input.viewport, input.proxy, async (_context, page, lease) => {
      page.setDefaultNavigationTimeout(timeout(input.timeoutMs));
      page.setDefaultTimeout(timeout(input.timeoutMs));
      const timeline: ExecutionTimelineEvent[] = [
        { atMs: 0, event: "accepted" },
        {
          atMs: Date.now() - started,
          event: "browser-acquired",
          detail: lease.reusedWorker ? "warm-worker" : "new-worker",
        },
      ];
      let documentStatus = 200;
      let documentContentType = "text/html";
      page.on("response", (candidate) => {
        if (
          candidate.request().isNavigationRequest() &&
          candidate.frame() === page.mainFrame()
        ) {
          documentStatus = candidate.status();
          documentContentType =
            candidate.headers()["content-type"] ?? documentContentType;
        }
      });
      const navigationStarted = Date.now();
      const response = await page.goto(input.url, {
        waitUntil: input.waitUntil ?? "domcontentloaded",
      });
      documentStatus = response?.status() ?? documentStatus;
      documentContentType =
        response?.headers()["content-type"] ?? documentContentType;
      const navigationMs = Date.now() - navigationStarted;
      timeline.push({
        atMs: Date.now() - started,
        event: "dom-content-loaded",
      });
      const wait = renderWait(input, options.defaultStability ?? false);
      const settleStarted = Date.now();
      if (wait)
        await waitForBrowserReadiness(page, wait, {
          minimumObservationMs:
            !input.wait && !input.waitUntil && options.defaultStability
              ? defaultStabilityObservationMs
              : 0,
        });
      let html = await page.content();
      const challengeBudgetMs = Math.min(
        8_000,
        Math.max(
          0,
          timeout(input.timeoutMs) - navigationMs - (Date.now() - settleStarted),
        ),
      );
      const challengeObservation = await observeChallengeResolution(
        page,
        html,
        challengeBudgetMs,
      );
      html = challengeObservation.html;
      const settleMs = Date.now() - settleStarted;
      timeline.push({
        atMs: Date.now() - started,
        event: "dom-settled",
        detail:
          challengeObservation.waitedMs > 0
            ? challengeObservation.resolved
              ? "challenge-resolved-passively"
              : "challenge-observation-expired"
            : (wait?.type ?? "no-post-navigation-wait"),
      });
      const finalUrl = normalizeUrl(page.url());
      const challengeDetected = hasAccessChallenge(html);
      const browserMs = Date.now() - started;
      return {
        sourceUrl: normalizeUrl(input.url),
        status: documentStatus,
        finalUrl,
        contentType: documentContentType,
        html,
        browserMs,
        networkBytes: Buffer.byteLength(html),
        execution: {
          plan: planExecution(input),
          backendAttempts: [backend],
          selectedBackend: backend,
          ...(challengeDetected
            ? { challengeDetected: true, challengeRemaining: true }
            : {}),
          ...(backend === "cloakbrowser-chromium"
            ? {
                backendConfiguration: {
                  fingerprintArgs: input.browserOptions?.fingerprintArgs ?? [],
                  humanize: input.browserOptions?.humanize ?? true,
                  ...(input.browserOptions?.humanPreset
                    ? { humanPreset: input.browserOptions.humanPreset }
                    : {}),
                  humanConfigKeys: Object.keys(
                    input.browserOptions?.humanConfig ?? {},
                  ).sort(),
                },
              }
            : {}),
          ...(backend === "camoufox-firefox"
            ? {
                backendConfiguration: {
                  camoufox: resolvedCamoufoxOptions(input.browserOptions),
                },
              }
            : {}),
          ...(backend === "clearcote-chromium"
            ? {
                backendConfiguration: {
                  fingerprintArgs: input.browserOptions?.fingerprintArgs ?? [],
                },
              }
            : {}),
          timings: {
            httpMs: 0,
            browserAcquireMs: lease.acquireMs,
            navigationMs,
            settleMs,
            extractionMs: 0,
            browserMs,
          },
          strategyRequested: input.strategy ?? "auto",
          strategyUsed: "browser" as const,
          escalated: false,
          timeline,
        },
      };
    }, backend, input.browserOptions)
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

async function renderWithChallengeFallback(
  pool: BrowserPool,
  input: FetchInput,
  decision: BrowserBackendDecision,
  options: { defaultStability?: boolean } = {},
): Promise<Omit<FetchResult, "strategy" | "attempted" | "fetchMs">> {
  const fallback = await runChallengeFallback(
    pool,
    input,
    decision.selected,
    async (candidate) => {
      const rendered = await browserBackend(candidate).render(
        pool,
        {
          ...input,
          browserBackend: candidate,
          ...(candidate === "cloakbrowser-chromium" ||
          candidate === "camoufox-firefox" ||
          candidate === "clearcote-chromium"
            ? {}
            : { browserOptions: undefined }),
        },
        options,
      );
      return {
        value: rendered,
        challengeDetected: Boolean(rendered.execution.challengeDetected),
      };
    },
  );
  fallback.value.execution.backendAttempts = fallback.backendAttempts;
  fallback.value.execution.selectedBackend = fallback.selectedBackend;
  fallback.value.execution.challengeRemaining = fallback.challengeRemaining;
  return fallback.value;
}

export async function adaptiveFetch(
  pool: BrowserPool,
  input: FetchInput,
): Promise<FetchResult> {
  const strategy = input.strategy ?? "auto";
  const plan = planExecution(input, {
    domainObservation: domainObservations.get(input.url),
  });
  if (strategy === "browser") {
    const backendDecision = selectBrowserBackend(input);
    const browser = await renderWithChallengeFallback(
      pool,
      input,
      backendDecision,
    );
    return {
      ...browser,
      strategy: "browser",
      attempted: ["browser"],
      fetchMs: 0,
      execution: {
        ...browser.execution,
        plan,
        backendDecisionReason:
          browser.execution.selectedBackend === backendDecision.selected
            ? backendDecision.reason
            : "challenge-fallback",
        strategyRequested: strategy,
        strategyUsed: "browser",
      },
    };
  }
  const http = await httpFetch(input);
  const httpChallenge = Boolean(http.html && hasAccessChallenge(http.html));
  const initialAnalysis = analyzeClientRendering({
    html: http.html,
    status: http.status,
    contentType: http.contentType,
  });
  const analysis = httpChallenge
    ? {
        ...initialAnalysis,
        browserRecommended: true,
        reason: "client-rendered-shell" as const,
        signals: [...initialAnalysis.signals, "access-challenge"],
      }
    : initialAnalysis;
  domainObservations.record(input.url, analysis);
  const resolved = strategy === "http" ? plan : resolvedPlan(plan, analysis);
  const httpTimeline: ExecutionTimelineEvent[] = [
    { atMs: 0, event: "accepted" },
    { atMs: 0, event: "http-started" },
    { atMs: http.fetchMs, event: "http-completed", detail: `status:${http.status}` },
    {
      atMs: http.fetchMs,
      event: "content-analyzed",
      detail: analysis.reason,
    },
  ];
  if (strategy === "http" || (!analysis.browserRecommended && !httpChallenge))
    return {
      ...http,
      strategy: "http",
      attempted: ["http"],
      browserMs: 0,
      execution: {
        ...http.execution,
        plan: resolved,
        strategyRequested: strategy,
        strategyUsed: "http",
        escalated: false,
        analysis,
        ...(httpChallenge
          ? { challengeDetected: true, challengeRemaining: true }
          : {}),
        timeline: httpTimeline,
      },
    };
  const backendDecision = selectBrowserBackend(input);
  httpTimeline.push(
    { atMs: http.fetchMs, event: "browser-required", detail: analysis.reason },
    {
      atMs: http.fetchMs,
      event: "backend-selected",
      detail: `${backendDecision.selected}:${backendDecision.reason}`,
    },
  );
  const browser = await renderWithChallengeFallback(
    pool,
    input,
    backendDecision,
    { defaultStability: true },
  );
  return {
    ...browser,
    strategy: "browser",
    attempted: ["http", "browser"],
    fetchMs: http.fetchMs,
    execution: {
      ...browser.execution,
      plan: resolved,
      escalationReason: "client-rendered-shell",
      backendDecisionReason:
        browser.execution.selectedBackend === backendDecision.selected
          ? backendDecision.reason
          : "challenge-fallback",
      timings: {
        ...browser.execution.timings,
        httpMs: http.fetchMs,
      },
      strategyRequested: strategy,
      strategyUsed: "browser",
      escalated: true,
      analysis,
      timeline: [
        ...httpTimeline,
        ...browser.execution.timeline
          .filter((event) => event.event !== "accepted")
          .map((event) => ({ ...event, atMs: event.atMs + http.fetchMs })),
      ],
    },
  };
}

export function transform(
  result: FetchResult,
  outputs: Output[],
): Pick<FetchResult, "html" | "text" | "markdown" | "links" | "metadata" | "article" | "provenance"> {
  if (!result.html) return {};
  const started = Date.now();
  const needsArticle = outputs.some((output) =>
    ["text", "markdown", "metadata", "article", "provenance"].includes(output),
  );
  const article = needsArticle
    ? extractArticle(
        result.html,
        result.sourceUrl,
        result.finalUrl,
        result.strategy,
        result.execution.selectedBackend,
      )
    : undefined;
  const readable = outputs.includes("markdown") || outputs.includes("links")
    ? readableContentHtml(result.html)
    : undefined;
  const $ = load(readable?.html ?? "");
  const answer: Pick<FetchResult, "html" | "text" | "markdown" | "links" | "metadata" | "article" | "provenance"> = {};
  if (outputs.includes("html")) answer.html = result.html;
  if (outputs.includes("text")) answer.text = article?.text ?? "";
  if (outputs.includes("markdown"))
    answer.markdown = article?.markdown ?? "";
  if (outputs.includes("metadata")) answer.metadata = article?.metadata ?? {};
  if (outputs.includes("article") && article) answer.article = article;
  if (outputs.includes("provenance")) answer.provenance = article?.evidence ?? [];
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
  result.execution.timings.extractionMs = Date.now() - started;
  const previousAt = result.execution.timeline.at(-1)?.atMs ?? 0;
  result.execution.timeline.push({
    atMs: previousAt + result.execution.timings.extractionMs,
    event: "extraction-complete",
  });
  return answer;
}

/** Primary backend descriptor used by planners and future operator adapters. */
export const playwrightChromiumBackend: BrowserBackend = {
  capabilities: playwrightChromiumCapabilities,
  render: browserFetch,
  health: (pool) => {
    const stats = pool.stats("playwright-chromium");
    return {
      id: "playwright-chromium",
      state:
        stats.healthy > 0 || stats.processes === 0
          ? "healthy"
          : stats.starting > 0
            ? "degraded"
            : "unavailable",
      processes: stats.processes,
      capacity: stats.contextCapacity,
      failures: stats.launchFailures,
      crashes: stats.crashes,
    };
  },
};

function backendHealth(pool: BrowserPool, id: BrowserBackendId) {
  const stats = pool.stats(id);
  return {
    id,
    state:
      stats.healthy > 0 || stats.processes === 0
        ? "healthy" as const
        : stats.starting > 0
          ? "degraded" as const
          : "unavailable" as const,
    processes: stats.processes,
    capacity: stats.contextCapacity,
    failures: stats.launchFailures,
    crashes: stats.crashes,
  };
}

export const patchrightChromiumBackend: BrowserBackend = {
  capabilities: patchrightChromiumCapabilities,
  render: browserFetch,
  health: (pool) => backendHealth(pool, "patchright-chromium"),
};

export const cloakBrowserChromiumBackend: BrowserBackend = {
  capabilities: cloakBrowserChromiumCapabilities,
  render: browserFetch,
  health: (pool) => backendHealth(pool, "cloakbrowser-chromium"),
};

export const camoufoxFirefoxBackend: BrowserBackend = {
  capabilities: camoufoxFirefoxCapabilities,
  render: browserFetch,
  health: (pool) => backendHealth(pool, "camoufox-firefox"),
};

export const clearcoteChromiumBackend: BrowserBackend = {
  capabilities: clearcoteChromiumCapabilities,
  render: browserFetch,
  health: (pool) => backendHealth(pool, "clearcote-chromium"),
};

export function browserBackend(id: BrowserBackendId): BrowserBackend {
  browserBackendCapability(id);
  if (id === "patchright-chromium") return patchrightChromiumBackend;
  if (id === "cloakbrowser-chromium") return cloakBrowserChromiumBackend;
  if (id === "camoufox-firefox") return camoufoxFirefoxBackend;
  if (id === "clearcote-chromium") return clearcoteChromiumBackend;
  return playwrightChromiumBackend;
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

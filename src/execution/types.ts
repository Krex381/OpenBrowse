import type { StoredProxy } from "../storage.js";

export type Strategy = "auto" | "http" | "browser";
export type Output =
  | "html"
  | "text"
  | "markdown"
  | "links"
  | "metadata"
  | "article"
  | "provenance";
export const browserBackendIds = [
  "playwright-chromium",
  "patchright-chromium",
  "cloakbrowser-chromium",
  "camoufox-firefox",
  "clearcote-chromium",
] as const;
export type BrowserBackendId = (typeof browserBackendIds)[number];
export type HumanizationValue = number | boolean | [number, number];
export const humanizationConfigKeys = [
  "typing_delay",
  "typing_delay_spread",
  "typing_pause_chance",
  "typing_pause_range",
  "shift_down_delay",
  "shift_up_delay",
  "key_hold",
  "field_switch_delay",
  "mistype_chance",
  "mistype_delay_notice",
  "mistype_delay_correct",
  "mouse_steps_divisor",
  "mouse_min_steps",
  "mouse_max_steps",
  "mouse_wobble_max",
  "mouse_overshoot_chance",
  "mouse_overshoot_px",
  "mouse_burst_size",
  "mouse_burst_pause",
  "click_aim_delay_input",
  "click_aim_delay_button",
  "click_hold_input",
  "click_hold_button",
  "click_input_x_range",
  "idle_drift_px",
  "idle_pause_range",
  "scroll_delta_base",
  "scroll_delta_variance",
  "scroll_pause_fast",
  "scroll_pause_slow",
  "scroll_accel_steps",
  "scroll_decel_steps",
  "scroll_overshoot_chance",
  "scroll_overshoot_px",
  "scroll_settle_delay",
  "scroll_target_zone",
  "scroll_pre_move_delay",
  "initial_cursor_x",
  "initial_cursor_y",
  "idle_between_actions",
  "idle_between_duration",
] as const;
export interface BrowserBackendOptions {
  /** CloakBrowser-only Chromium flags. Only the --fingerprint namespace is accepted. */
  fingerprintArgs?: string[];
  humanize?: boolean;
  humanPreset?: "default" | "careful";
  humanConfig?: Partial<
    Record<(typeof humanizationConfigKeys)[number], HumanizationValue>
  >;
  /** Camoufox-only, bounded Firefox identity and interaction settings. */
  camoufox?: {
    os?: "windows" | "macos" | "linux";
    locale?: string | string[];
    humanize?: boolean | number;
    blockImages?: boolean;
    blockWebrtc?: boolean;
    enableCache?: boolean;
  };
}
export type ExecutionStage = "http" | "browser";
export type PlannedStrategy =
  | "HTTP"
  | "HTTP_THEN_BROWSER"
  | "BROWSER"
  | "PERSISTENT_SESSION";
export type PlannerReason =
  | "explicit-http"
  | "explicit-browser"
  | "auto-http-first"
  | "client-rendered-shell"
  | "http-content-sufficient"
  | "http-status-terminal"
  | "non-html-response"
  | "persistent-session"
  | "browser-capacity-unavailable";
export type NavigationWait = "load" | "domcontentloaded" | "networkidle";
export type BrowserWait =
  | { type: "domcontentloaded" }
  | { type: "load" }
  | { type: "networkidle"; timeoutMs?: number }
  | { type: "selector"; selector: string; state?: "attached" | "visible" }
  | { type: "delay"; ms: number }
  | { type: "stability"; quietMs?: number; timeoutMs?: number };

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

export interface FetchInput {
  url: string;
  strategy?: Strategy;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** @deprecated Use `wait` for post-navigation readiness control. */
  waitUntil?: NavigationWait;
  wait?: BrowserWait;
  output?: Output[];
  browserBackend?: BrowserBackendId;
  browserOptions?: BrowserBackendOptions;
  viewport?: Viewport;
  proxy?: StoredProxy;
}

export interface ExecutionPlan {
  strategy: PlannedStrategy;
  requestedStrategy: Strategy | "session";
  stages: ExecutionStage[];
  browserBackend?: BrowserBackendId;
  reason: PlannerReason;
  attemptBudget: number;
  estimatedMemoryMb: number;
  estimatedCost: { units: number; basis: "http" | "browser" };
  cacheEligible: boolean;
  cacheEligibility: {
    eligible: boolean;
    reason:
      | "public-request"
      | "private-request-headers"
      | "caller-disabled"
      | "challenge-response";
  };
  browserRequired: boolean;
  signals: string[];
}

export interface ExecutionTimings {
  httpMs: number;
  browserAcquireMs: number;
  navigationMs: number;
  settleMs: number;
  extractionMs: number;
  browserMs: number;
}

export interface ArticleMetadata {
  title?: string;
  description?: string;
  author?: string;
  publishedAt?: string;
  modifiedAt?: string;
  language?: string;
  canonicalUrl?: string;
  image?: string;
  siteName?: string;
}

export interface ArticleAccess {
  status: "open" | "partial" | "restricted" | "unknown";
  restricted: boolean;
  type?: "paywall" | "authentication" | "access-challenge";
  contentScope: "full" | "public-teaser" | "unknown";
  paywallDetected: boolean;
  signals: string[];
}

export type ProvenanceEvidence = "DIRECT" | "METADATA" | "INFERRED";
export interface ProvenanceRecord {
  claim: string;
  source: {
    method: "http" | "browser";
    backend?: BrowserBackendId;
    view: "document" | "main-content" | "metadata";
    selector?: string;
    url: string;
  };
  evidence: ProvenanceEvidence;
}

export interface ArticleResult {
  text: string;
  markdown: string;
  wordCount: number;
  metadata: ArticleMetadata;
  access: ArticleAccess;
  provenance: {
    sourceUrl: string;
    finalUrl: string;
    extractedAt: string;
    strategy: "http" | "browser";
    browserBackend?: BrowserBackendId;
  };
  evidence: ProvenanceRecord[];
}

export interface ClientRenderAnalysis {
  browserRecommended: boolean;
  reason:
    | "client-rendered-shell"
    | "http-content-sufficient"
    | "http-status-terminal"
    | "non-html-response";
  signals: string[];
  textChars: number;
  htmlChars: number;
  scriptChars: number;
  scriptCount: number;
  meaningfulTextDensity: number;
}

export interface ExecutionTimelineEvent {
  atMs: number;
  event:
    | "accepted"
    | "http-started"
    | "http-completed"
    | "content-analyzed"
    | "browser-required"
    | "backend-selected"
    | "browser-acquired"
    | "dom-content-loaded"
    | "dom-settled"
    | "extraction-complete";
  detail?: string;
}

export interface FetchResult {
  sourceUrl: string;
  status: number;
  finalUrl: string;
  strategy: "http" | "browser";
  attempted: ("http" | "browser")[];
  contentType: string;
  html?: string;
  markdown?: string;
  links?: string[];
  text?: string;
  metadata?: ArticleMetadata;
  article?: ArticleResult;
  provenance?: ProvenanceRecord[];
  fetchMs: number;
  browserMs: number;
  networkBytes: number;
  execution: {
    plan: ExecutionPlan;
    escalationReason?: PlannerReason;
    backendAttempts: BrowserBackendId[];
    selectedBackend?: BrowserBackendId;
    backendDecisionReason?:
      | "requested-supported-backend"
      | "default-compatible-backend"
      | "challenge-fallback";
    backendConfiguration?: {
      fingerprintArgs?: string[];
      humanize?: boolean;
      humanPreset?: "default" | "careful";
      humanConfigKeys?: string[];
      camoufox?: {
        os: "windows" | "macos" | "linux";
        locale?: string | string[];
        humanize: boolean | number;
        blockImages: boolean;
        blockWebrtc: boolean;
        enableCache: boolean;
      };
    };
    challengeDetected?: boolean;
    challengeRemaining?: boolean;
    timings: ExecutionTimings;
    strategyRequested: Strategy;
    strategyUsed: "http" | "browser";
    escalated: boolean;
    analysis?: ClientRenderAnalysis;
    timeline: ExecutionTimelineEvent[];
  };
}

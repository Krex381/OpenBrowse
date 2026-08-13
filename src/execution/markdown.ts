import { load, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

const ignored = "script,style,noscript,template,svg,canvas,iframe,form";
const articleCandidates = [
  "article",
  "main",
  "[role='main']",
  "[itemprop='articleBody']",
  "[itemtype*='Article']",
  ".article",
  ".post",
  ".entry-content",
  "[class*='article']",
  "[class*='post']",
  "[class*='entry-content']",
  "[class*='story']",
].join(",");
const articleSignals = ["article", "articlebody", "newsarticle", "post", "entry-content", "story"];
const noiseSignals = [
  "audio",
  "advert",
  "aside",
  "breadcrumb",
  "comment",
  "footer",
  "menu",
  "most-read",
  "navigation",
  "newsletter",
  "player",
  "recommend",
  "related",
  "share",
  "sidebar",
  "social",
];
const noiseTextPatterns = [
  /google[-\s]?(?:quelle|source)/i,
  /(?:mehr|more)\s+[^\n]{0,48}\s+(?:artikel|articles)/i,
];
const paywallPattern = /(?:weiterlesen\s+mit\s+(?:ihrem\s+)?digitalen\s+zugang|paywall|subscribe\s+to\s+continue|sign\s+in\s+to\s+continue)/i;
const blocks = new Set([
  "article",
  "aside",
  "blockquote",
  "div",
  "figure",
  "figcaption",
  "footer",
  "header",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);

function clean(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function tagName(element: AnyNode): string {
  const named = element as AnyNode & { name?: unknown; tagName?: unknown };
  const value =
    typeof named.name === "string"
      ? named.name
      : typeof named.tagName === "string"
        ? named.tagName
        : "";
  return value.toLowerCase();
}

function elementMetadata($: CheerioAPI, element: AnyNode): string {
  return [
    tagName(element),
    $(element).attr("id") ?? "",
    $(element).attr("class") ?? "",
    $(element).attr("role") ?? "",
    $(element).attr("itemprop") ?? "",
    $(element).attr("itemtype") ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

function hasAny(value: string, signals: readonly string[]): boolean {
  return signals.some((signal) => value.includes(signal));
}

function isNoiseElement($: CheerioAPI, element: AnyNode): boolean {
  const name = tagName(element);
  if (["nav", "footer", "aside"].includes(name)) return true;
  if (name === "header" && $(element).find("h1").length === 0) return true;
  const metadata = elementMetadata($, element);
  const text = clean($(element).text());
  return (
    hasAny(metadata, noiseSignals) ||
    (text.length <= 320 && noiseTextPatterns.some((pattern) => pattern.test(text)))
  );
}

function candidateScore($: CheerioAPI, element: AnyNode): number {
  const text = clean($(element).text());
  if (text.length < 120) return Number.NEGATIVE_INFINITY;
  const metadata = elementMetadata($, element);
  const paragraphText = $(element)
    .find("p")
    .toArray()
    .reduce((total, paragraph) => total + clean($(paragraph).text()).length, 0);
  const links = $(element)
    .find("a")
    .toArray()
    .reduce((total, link) => total + clean($(link).text()).length, 0);
  const linkDensity = links / Math.max(1, text.length);
  const semanticBonus =
    (tagName(element) === "article" ? 2_000 : 0) +
    (metadata.includes("articlebody") ? 2_400 : 0) +
    (hasAny(metadata, articleSignals) ? 1_200 : 0) +
    ($(element).find("h1").length > 0 ? 1_600 : 0) +
    ($(element).find("h2").length > 0 ? 120 : 0);
  const directNoisePenalty = hasAny(metadata, noiseSignals) ? 3_000 : 0;
  const descendantNoisePenalty = $(element)
    .find("*")
    .toArray()
    .filter((child) => isNoiseElement($, child))
    .reduce((total, child) => total + Math.min(600, clean($(child).text()).length), 0);
  return (
    Math.min(9_000, text.length) * 0.25 +
    Math.min(6_000, paragraphText) * 0.9 +
    $(element).find("p").length * 140 +
    semanticBonus -
    linkDensity * text.length * 1.4 -
    directNoisePenalty -
    descendantNoisePenalty
  );
}

function mainContent($: CheerioAPI): AnyNode | undefined {
  const candidates = new Set<AnyNode>($(articleCandidates).toArray());
  for (const heading of $("h1").toArray()) {
    for (const ancestor of $(heading).parents().toArray().slice(0, 6)) {
      if (["body", "html"].includes(tagName(ancestor))) continue;
      candidates.add(ancestor);
    }
  }
  const best = [...candidates]
    .map((element) => ({ element, score: candidateScore($, element) }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => right.score - left.score)[0];
  return best?.element ?? $("body").get(0);
}

function removeNoise($: CheerioAPI, root: AnyNode): void {
  $(root)
    .find("*")
    .toArray()
    .filter((element) => isNoiseElement($, element))
    .forEach((element) => $(element).remove());
}

function trimAtPaywall($: CheerioAPI, root: AnyNode): boolean {
  const marker = $(root)
    .find("*")
    .toArray()
    .filter((element) => paywallPattern.test(clean($(element).text())))
    .sort((left, right) => clean($(left).text()).length - clean($(right).text()).length)[0];
  if (!marker) return false;
  let boundary = marker;
  while (true) {
    const parent = $(boundary).parent().get(0);
    if (!parent || parent === root || $(parent).children().length !== 1) break;
    boundary = parent;
  }
  $(boundary).nextAll().remove();
  $(boundary).remove();
  return true;
}

function absoluteUrl(value: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(value, baseUrl);
    return /^https?:$/.test(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function inline($: CheerioAPI, element: AnyNode, baseUrl: string): string {
  const name = tagName(element);
  const children = $(element)
    .contents()
    .toArray()
    .map((child) => {
      if (child.type === "text") return $(child).text();
      return inline($, child, baseUrl);
    })
    .join("");
  const text = clean(children);
  if (!text && name !== "img") return "";
  if (name === "a") {
    const href = absoluteUrl($(element).attr("href") ?? "", baseUrl);
    return href ? `[${text || href}](${href})` : text;
  }
  if (name === "img") {
    const source = absoluteUrl($(element).attr("src") ?? "", baseUrl);
    const alt = clean($(element).attr("alt") ?? "");
    return source ? `![${alt}](${source})` : alt;
  }
  if (name === "code") return `\`${text.replaceAll("`", "\\`")}\``;
  if (name === "strong" || name === "b") return text ? `**${text}**` : "";
  if (name === "em" || name === "i") return text ? `*${text}*` : "";
  if (name === "br") return "\n";
  return children;
}

function list($: CheerioAPI, element: AnyNode, baseUrl: string, depth: number): string {
  const ordered = tagName(element) === "ol";
  return $(element)
    .children("li")
    .toArray()
    .map((item, index) => {
      const body = $(item)
        .contents()
        .toArray()
        .filter((child) => !["ul", "ol"].includes(tagName(child)))
        .map((child) => (child.type === "text" ? $(child).text() : inline($, child, baseUrl)))
        .join("");
      const nested = $(item)
        .children("ul,ol")
        .toArray()
        .map((child) => list($, child, baseUrl, depth + 1))
        .join("\n");
      const prefix = ordered ? `${index + 1}.` : "-";
      return `${"  ".repeat(depth)}${prefix} ${clean(body)}${nested ? `\n${nested}` : ""}`;
    })
    .join("\n");
}

function table($: CheerioAPI, element: AnyNode, baseUrl: string): string {
  const rows = $(element).find("tr").toArray();
  const values = rows.map((row) =>
    $(row)
      .children("th,td")
      .toArray()
      .map((cell) => clean(inline($, cell, baseUrl)).replaceAll("|", "\\|")),
  );
  if (!values.length || !values[0]?.length) return "";
  const header = values[0];
  const body = values.slice(1);
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function block($: CheerioAPI, element: AnyNode, baseUrl: string): string {
  const name = tagName(element);
  if (/^h[1-6]$/.test(name))
    return `${"#".repeat(Number(name[1]))} ${clean(inline($, element, baseUrl))}`;
  if (name === "pre") {
    const code = $(element).find("code").first();
    const language = /language-([\w-]+)/.exec(code.attr("class") ?? "")?.[1] ?? "";
    return `\`\`\`${language}\n${$(element).text().trim()}\n\`\`\``;
  }
  if (name === "blockquote")
    return clean($(element).text())
      .split("\n")
      .filter(Boolean)
      .map((line) => `> ${line.trim()}`)
      .join("\n");
  if (name === "ul" || name === "ol") return list($, element, baseUrl, 0);
  if (name === "table") return table($, element, baseUrl);
  if (name === "hr") return "---";
  if (name === "img") return inline($, element, baseUrl);
  const children = $(element)
    .contents()
    .toArray()
    .map((child) => {
      if (child.type === "text") return $(child).text();
      return blocks.has(tagName(child))
        ? block($, child, baseUrl)
        : inline($, child, baseUrl);
    })
    .join(name === "p" ? "" : "\n");
  return clean(children);
}

export interface ReadableDocument {
  html: string;
  paywallDetected: boolean;
}

/** Isolates the highest-quality article region before output conversion. */
export function readableContentHtml(html: string): ReadableDocument {
  const $ = load(html);
  $(ignored).remove();
  const root = mainContent($);
  if (!root) return { html: "", paywallDetected: false };
  const clone = $(root).clone().get(0);
  if (!clone) return { html: "", paywallDetected: false };
  removeNoise($, clone);
  const paywallDetected = trimAtPaywall($, clone);
  return { html: $.html(clone), paywallDetected };
}

/** Converts the readable document region into stable, LLM-ready Markdown. */
export function htmlToMarkdown(html: string, baseUrl: string): string {
  const readable = readableContentHtml(html);
  if (!readable.html) return "";
  const $ = load(readable.html);
  const root = $("body").get(0);
  if (!root) return "";
  const markdown = clean(
    $(root)
      .contents()
      .toArray()
      .map((element) =>
        element.type === "text" ? $(element).text() : block($, element, baseUrl),
      )
      .filter(Boolean)
      .join("\n\n"),
  );
  return readable.paywallDetected
    ? clean(`${markdown}\n\n> Paywall notice: Further article text requires access.`)
    : markdown;
}

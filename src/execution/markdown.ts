import { load, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

const ignored = "script,style,noscript,template,svg,canvas,iframe,form";
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

function mainContent($: CheerioAPI): AnyNode | undefined {
  const candidates = $("article, main, [role='main'], .article, .post, .entry-content")
    .toArray()
    .map((element) => ({ element, score: $(element).text().trim().length }))
    .filter((candidate) => candidate.score >= 160)
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.element ?? $("body").get(0);
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

/** Converts the readable document region into stable, LLM-ready Markdown. */
export function htmlToMarkdown(html: string, baseUrl: string): string {
  const $ = load(html);
  $(ignored).remove();
  $("nav,footer,aside,[role='navigation'],[role='complementary']").remove();
  const root = mainContent($);
  if (!root) return "";
  return clean(
    $(root)
      .contents()
      .toArray()
      .map((element) =>
        element.type === "text" ? $(element).text() : block($, element, baseUrl),
      )
      .filter(Boolean)
      .join("\n\n"),
  );
}

import { z } from "zod";
import { config } from "../../config.js";
import { OpenBrowseError } from "../../errors.js";
import type { SessionManager } from "../../execution.js";
import { normalizeUrl } from "../../security.js";
import type { StoredProxy, StoredSession } from "../../storage.js";
import { agentCommandSchema, parse, url, type AgentCommand } from "../input.js";
import { type BqlField } from "../browserql.js";
import { hasAccessChallenge } from "../../execution/shared.js";

export function createBqlExecutor(input: {
  sessions: SessionManager;
  resolveProxy(id: string | undefined, ownerKeyHash?: string): Promise<StoredProxy | undefined>;
  executeAgentCommand(
    session: StoredSession,
    command: AgentCommand,
  ): Promise<unknown>;
}) {
  const { sessions, resolveProxy, executeAgentCommand } = input;
  const bqlNetwork = new Map<
    string,
    {
      requests: Array<{ url: string; method: string }>;
      responses: Array<{
        url: string;
        status: number;
        contentType?: string;
        body?: string;
        bodyTruncated?: boolean;
      }>;
      pending: Promise<void>[];
      captureBodies: boolean;
    }
  >();
  const executeBqlField = async (
    session: StoredSession,
    field: BqlField,
  ): Promise<unknown> => {
    const command = (method: AgentCommand["method"], params: unknown) =>
      executeAgentCommand(
        session,
        parse(agentCommandSchema, { method, params }),
      );
    const args = field.args;
    switch (field.name) {
      case "goto": {
        const input = parse(
          z.object({
            url,
            waitUntil: z
              .enum([
                "load",
                "domcontentloaded",
                "domContentLoaded",
                "networkidle",
                "networkIdle",
              ])
              .optional(),
          }),
          args,
        );
        return command("goto", {
          ...input,
          ...(input.waitUntil === "networkIdle"
            ? { waitUntil: "networkidle" }
            : input.waitUntil === "domContentLoaded"
              ? { waitUntil: "domcontentloaded" }
              : {}),
        });
      }
      case "back":
      case "forward":
      case "reload": {
        const input = parse(
          z.object({
            waitUntil: z
              .enum([
                "load",
                "domcontentloaded",
                "domContentLoaded",
                "networkidle",
                "networkIdle",
              ])
              .optional(),
          }),
          args,
        );
        return command(field.name, {
          ...(input.waitUntil === "networkIdle"
            ? { waitUntil: "networkidle" }
            : input.waitUntil === "domContentLoaded"
              ? { waitUntil: "domcontentloaded" }
              : input),
        });
      }
      case "click":
        return command(
          "click",
          parse(z.object({ selector: z.string().min(1).max(512) }), args),
        );
      case "checkbox":
        return command(
          "checkbox",
          parse(
            z.object({
              selector: z.string().min(1).max(512),
              checked: z.boolean().default(true),
            }),
            args,
          ),
        );
      case "type": {
        const input = parse(
          z.object({
            selector: z.string().min(1).max(512),
            text: z.string().max(10000),
            delayMs: z.number().int().min(0).max(1000).default(0),
          }),
          args,
        );
        const live = await sessions.get(
          session,
          await resolveProxy(session.proxyId, session.ownerKeyHash),
        );
        const started = Date.now();
        const locator = live.page.locator(input.selector).first();
        await locator.click({ timeout: config.jobTimeoutMs });
        await locator.pressSequentially(input.text, { delay: input.delayMs });
        return {
          selector: input.selector,
          text: input.text,
          typed: input.text.length,
          time: Date.now() - started,
        };
      }
      case "select":
        return command(
          "select",
          parse(
            z.object({
              selector: z.string().min(1).max(512),
              value: z.string().max(2048),
            }),
            args,
          ),
        );
      case "hover":
        return command(
          "hover",
          parse(z.object({ selector: z.string().min(1).max(512) }), args),
        );
      case "scroll":
        return command(
          "scroll",
          parse(
            z.object({
              selector: z.string().min(1).max(512).optional(),
              direction: z
                .enum(["up", "down", "left", "right"])
                .default("down"),
            }),
            args,
          ),
        );
      case "waitForSelector": {
        const input = parse(
          z
            .object({
              selector: z.string().min(1).max(512),
              timeout: z
                .number()
                .int()
                .min(100)
                .max(config.jobTimeoutMs)
                .optional(),
              visible: z.boolean().default(false),
              hidden: z.boolean().default(false),
            })
            .superRefine((value, context) => {
              if (value.visible && value.hidden)
                context.addIssue({
                  code: "custom",
                  message: "visible and hidden cannot both be true",
                });
            }),
          args,
        );
        const live = await sessions.get(
          session,
          await resolveProxy(session.proxyId, session.ownerKeyHash),
        );
        const started = Date.now();
        const locator = live.page.locator(input.selector).first();
        await locator.waitFor({
          state: input.hidden
            ? "hidden"
            : input.visible
              ? "visible"
              : "attached",
          timeout: input.timeout ?? config.jobTimeoutMs,
        });
        const box = input.hidden ? null : await locator.boundingBox();
        return {
          selector: input.selector,
          time: Date.now() - started,
          ...(box
            ? { x: box.x, y: box.y, width: box.width, height: box.height }
            : {}),
        };
      }
      case "waitForTimeout":
        return command(
          "waitForTimeout",
          parse(
            z.object({
              time: z.number().int().min(0).max(config.jobTimeoutMs),
            }),
            args,
          ),
        );
      case "waitForNavigation":
        return command(
          "waitForNavigation",
          parse(
            z.object({
              timeout: z
                .number()
                .int()
                .min(100)
                .max(config.jobTimeoutMs)
                .optional(),
            }),
            args,
          ),
        );
      case "waitForRequest": {
        const input = parse(
          z.object({
            url: z.string().min(1).max(512).optional(),
            method: z.string().min(1).max(16).optional(),
            timeout: z
              .number()
              .int()
              .min(100)
              .max(config.jobTimeoutMs)
              .optional(),
          }),
          args,
        );
        const prior = bqlNetwork
          .get(session.id)
          ?.requests.find(
            (candidate) =>
              (!input.url || candidate.url.includes(input.url)) &&
              (!input.method ||
                candidate.method === input.method.toUpperCase()),
          );
        return prior ?? command("waitForRequest", input);
      }
      case "waitForResponse": {
        const input = parse(
          z.object({
            url: z.string().min(1).max(512).optional(),
            statuses: z
              .array(z.number().int().min(100).max(599))
              .max(50)
              .optional(),
            timeout: z
              .number()
              .int()
              .min(100)
              .max(config.jobTimeoutMs)
              .optional(),
          }),
          args,
        );
        const prior = bqlNetwork
          .get(session.id)
          ?.responses.find(
            (candidate) =>
              (!input.url || candidate.url.includes(input.url)) &&
              (!input.statuses || input.statuses.includes(candidate.status)),
          );
        return prior ?? command("waitForResponse", input);
      }
      case "network": {
        const network = bqlNetwork.get(session.id);
        if (!network) return { requests: [], responses: [] };
        await Promise.all(network.pending);
        return { requests: network.requests, responses: network.responses };
      }
      case "evaluate":
        return command(
          "evaluate",
          parse(z.object({ content: z.string().min(1).max(10000) }), args),
        );
      case "text": {
        const { selector: target } = parse(
          z.object({ selector: z.string().min(1).max(512).default("body") }),
          args,
        );
        return command("text", { selector: target });
      }
      case "html": {
        const { selector: target } = parse(
          z.object({ selector: z.string().min(1).max(512).optional() }),
          args,
        );
        return command("html", target ? { selector: target } : {});
      }
      case "content": {
        const { html } = parse(
          z.object({ html: z.string().max(config.maxResponseBytes) }),
          args,
        );
        const live = await sessions.get(
          session,
          await resolveProxy(session.proxyId, session.ownerKeyHash),
        );
        await live.page.setContent(html, {
          waitUntil: "domcontentloaded",
          timeout: config.jobTimeoutMs,
        });
        return { status: 200, url: normalizeUrl(live.page.url()) };
      }
      case "title": {
        const live = await sessions.get(
          session,
          await resolveProxy(session.proxyId, session.ownerKeyHash),
        );
        return { title: await live.page.title() };
      }
      case "url": {
        const live = await sessions.get(
          session,
          await resolveProxy(session.proxyId, session.ownerKeyHash),
        );
        return { url: normalizeUrl(live.page.url()) };
      }
      case "cookies": {
        const input = parse(
          z.object({
            cookies: z
              .array(
                z
                  .object({
                    name: z.string().min(1).max(256),
                    value: z.string().max(4096),
                    url: url.optional(),
                    domain: z.string().min(1).max(253).optional(),
                    path: z.string().max(1024).default("/"),
                    secure: z.boolean().optional(),
                    httpOnly: z.boolean().optional(),
                    sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
                    expires: z.number().optional(),
                  })
                  .superRefine((cookie, context) => {
                    if (!cookie.url && !cookie.domain)
                      context.addIssue({
                        code: "custom",
                        message: "Cookie requires url or domain",
                      });
                  }),
              )
              .min(1)
              .max(100)
              .optional(),
          }),
          args,
        );
        const live = await sessions.get(
          session,
          await resolveProxy(session.proxyId, session.ownerKeyHash),
        );
        if (input.cookies) {
          const cookies = input.cookies.map((cookie) => {
            const {
              url: cookieUrl,
              domain: _domain,
              path: _path,
              ...common
            } = cookie;
            return cookieUrl
              ? { ...common, url: cookieUrl }
              : { ...common, domain: _domain!, path: _path };
          });
          await live.context.addCookies(cookies);
        }
        return {
          cookies: await live.context.cookies(),
          updated: input.cookies?.length ?? 0,
        };
      }
      case "screenshot": {
        const input = parse(
          z.object({
            fullPage: z.boolean().default(false),
            selector: z.string().min(1).max(512).optional(),
            type: z.enum(["png", "jpeg", "jpg"]).default("png"),
            quality: z.number().int().min(0).max(100).optional(),
            omitBackground: z.boolean().default(false),
          }),
          args,
        );
        const live = await sessions.get(
          session,
          await resolveProxy(session.proxyId, session.ownerKeyHash),
        );
        const type = input.type === "jpg" ? "jpeg" : input.type;
        const image = input.selector
          ? await live.page
              .locator(input.selector)
              .first()
              .screenshot({
                type,
                ...(type === "jpeg" && input.quality !== undefined
                  ? { quality: input.quality }
                  : {}),
              })
          : await live.page.screenshot({
              type,
              fullPage: input.fullPage,
              omitBackground: input.omitBackground,
              ...(type === "jpeg" && input.quality !== undefined
                ? { quality: input.quality }
                : {}),
            });
        if (image.length > config.maxResponseBytes)
          throw new OpenBrowseError(
            "RESPONSE_TOO_LARGE",
            "BrowserQL screenshot exceeds the configured response limit",
            413,
          );
        return {
          base64: image.toString("base64"),
          mimeType: type === "png" ? "image/png" : "image/jpeg",
          format: type,
          bytes: image.length,
        };
      }
      case "pdf": {
        const live = await sessions.get(
          session,
          await resolveProxy(session.proxyId, session.ownerKeyHash),
        );
        const input = parse(
          z.object({
            format: z
              .enum([
                "Letter",
                "Legal",
                "Tabloid",
                "Ledger",
                "A0",
                "A1",
                "A2",
                "A3",
                "A4",
                "A5",
                "A6",
              ])
              .optional(),
            landscape: z.boolean().default(false),
            printBackground: z.boolean().default(false),
            scale: z.number().min(0.1).max(2).default(1),
            pageRanges: z.string().max(256).optional(),
            preferCSSPageSize: z.boolean().default(false),
            displayHeaderFooter: z.boolean().default(false),
            headerTemplate: z.string().max(4096).optional(),
            footerTemplate: z.string().max(4096).optional(),
            marginTop: z.string().max(32).optional(),
            marginRight: z.string().max(32).optional(),
            marginBottom: z.string().max(32).optional(),
            marginLeft: z.string().max(32).optional(),
          }),
          args,
        );
        const document = await live.page.pdf({
          ...input,
          ...(input.marginTop ||
          input.marginRight ||
          input.marginBottom ||
          input.marginLeft
            ? {
                margin: {
                  top: input.marginTop,
                  right: input.marginRight,
                  bottom: input.marginBottom,
                  left: input.marginLeft,
                },
              }
            : {}),
        });
        if (document.length > config.maxResponseBytes)
          throw new OpenBrowseError(
            "RESPONSE_TOO_LARGE",
            "BrowserQL PDF exceeds the configured response limit",
            413,
          );
        return {
          base64: document.toString("base64"),
          mimeType: "application/pdf",
          bytes: document.length,
          size: document.length,
        };
      }
      case "querySelector": {
        const { selector: target, visible } = parse(
          z.object({
            selector: z.string().min(1).max(512),
            visible: z.boolean().default(false),
          }),
          args,
        );
        const live = await sessions.get(
          session,
          await resolveProxy(session.proxyId, session.ownerKeyHash),
        );
        const locator = live.page.locator(target).first();
        if (visible)
          await locator.waitFor({
            state: "visible",
            timeout: config.jobTimeoutMs,
          });
        return locator.evaluate((element) => ({
          text: (element.textContent ?? "").trim(),
          innerHTML: element.innerHTML,
          outerHTML: element.outerHTML,
        }));
      }
      case "querySelectorAll": {
        const { selector: target, visible } = parse(
          z.object({
            selector: z.string().min(1).max(512),
            visible: z.boolean().default(false),
          }),
          args,
        );
        const live = await sessions.get(
          session,
          await resolveProxy(session.proxyId, session.ownerKeyHash),
        );
        const locator = live.page.locator(target);
        if (visible)
          await locator
            .first()
            .waitFor({ state: "visible", timeout: config.jobTimeoutMs });
        return locator.evaluateAll((elements) =>
          elements.map((element) => ({
            id: element.id,
            className: element.getAttribute("class") ?? "",
            childElementCount: element.children.length,
            innerHTML: element.innerHTML,
            innerText: element.textContent ?? "",
            localName: element.localName,
            outerHTML: element.outerHTML,
          })),
        );
      }
      case "solve": {
        const live = await sessions.get(
          session,
          await resolveProxy(session.proxyId, session.ownerKeyHash),
        );
        const found = hasAccessChallenge(await live.page.content());
        return {
          found,
          solved: !found,
          backend: live.backend,
          retryRecommended: found,
        };
      }
      default:
        throw new OpenBrowseError(
          "UNSUPPORTED_OPERATION",
          `BrowserQL action is not implemented: ${field.name}`,
          404,
        );
    }
  };
  return { executeBqlField, bqlNetwork };
}

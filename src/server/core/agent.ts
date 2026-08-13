import { config } from "../../config.js";
import { OpenBrowseError } from "../../errors.js";
import type { SessionManager } from "../../execution.js";
import { assertSafeUrl, normalizeUrl } from "../../security.js";
import type { StoredProxy, StoredSession, Storage } from "../../storage.js";
import type { AgentCommand } from "../input.js";
import { agentSnapshot } from "../browserql.js";

export function createAgentExecutor(input: {
  storage: Storage;
  sessions: SessionManager;
  resolveProxy(id: string | undefined, ownerKeyHash?: string): Promise<StoredProxy | undefined>;
}) {
  const { storage, sessions, resolveProxy } = input;
  const executeAgentCommand = async (
    session: StoredSession,
    command: AgentCommand,
  ): Promise<unknown> => {
    const live = await sessions.get(
      session,
      await resolveProxy(session.proxyId, session.ownerKeyHash),
    );
    const page = live.page;
    const timeoutMs =
      "timeout" in command.params && command.params.timeout
        ? command.params.timeout
        : config.jobTimeoutMs;
    switch (command.method) {
      case "goto": {
        await assertSafeUrl(command.params.url);
        const response = await page.goto(command.params.url, {
          waitUntil: command.params.waitUntil ?? "domcontentloaded",
          timeout: timeoutMs,
        });
        return {
          status: response?.status() ?? 200,
          url: normalizeUrl(page.url()),
        };
      }
      case "back":
      case "forward":
      case "reload": {
        const response =
          command.method === "back"
            ? await page.goBack({
                waitUntil: command.params.waitUntil ?? "domcontentloaded",
                timeout: timeoutMs,
              })
            : command.method === "forward"
              ? await page.goForward({
                  waitUntil: command.params.waitUntil ?? "domcontentloaded",
                  timeout: timeoutMs,
                })
              : await page.reload({
                  waitUntil: command.params.waitUntil ?? "domcontentloaded",
                  timeout: timeoutMs,
                });
        return {
          status: response?.status() ?? 200,
          url: normalizeUrl(page.url()),
        };
      }
      case "snapshot":
        return {
          url: normalizeUrl(page.url()),
          title: await page.title(),
          elements: await agentSnapshot(page, command.params.maxElements),
        };
      case "text": {
        const value = await page
          .locator(command.params.selector)
          .first()
          .textContent({ timeout: timeoutMs });
        if (value === null)
          throw new OpenBrowseError(
            "SELECTOR_NOT_FOUND",
            "Selector did not match an element",
            404,
            true,
          );
        return { text: value.trim() };
      }
      case "html":
        return {
          html: command.params.selector
            ? await page
                .locator(command.params.selector)
                .first()
                .innerHTML({ timeout: timeoutMs })
            : await page.content(),
        };
      case "evaluate":
        return { value: await page.evaluate(command.params.content) };
      case "click":
        await page
          .locator(command.params.selector)
          .first()
          .click({ timeout: timeoutMs });
        return { clicked: true };
      case "type":
        await page
          .locator(command.params.selector)
          .first()
          .fill(command.params.text, { timeout: timeoutMs });
        return { typed: command.params.text.length };
      case "select":
        return {
          selected: await page
            .locator(command.params.selector)
            .first()
            .selectOption(command.params.value, { timeout: timeoutMs }),
        };
      case "checkbox":
        await page
          .locator(command.params.selector)
          .first()
          .setChecked(command.params.checked, { timeout: timeoutMs });
        return { checked: command.params.checked };
      case "hover":
        await page
          .locator(command.params.selector)
          .first()
          .hover({ timeout: timeoutMs });
        return { hovered: true };
      case "scroll": {
        const delta =
          command.params.direction === "up" ||
          command.params.direction === "left"
            ? -700
            : 700;
        if (command.params.selector)
          await page
            .locator(command.params.selector)
            .first()
            .evaluate(
              (element, amount) => {
                element.scrollBy({
                  left: amount.left,
                  top: amount.top,
                  behavior: "instant",
                });
              },
              {
                left:
                  command.params.direction === "left" ||
                  command.params.direction === "right"
                    ? delta
                    : 0,
                top:
                  command.params.direction === "up" ||
                  command.params.direction === "down"
                    ? delta
                    : 0,
              },
            );
        else
          await page.evaluate(
            `scrollBy(${command.params.direction === "left" || command.params.direction === "right" ? delta : 0}, ${command.params.direction === "up" || command.params.direction === "down" ? delta : 0})`,
          );
        return { scrolled: true };
      }
      case "waitForSelector":
        await page
          .locator(command.params.selector)
          .first()
          .waitFor({ state: "visible", timeout: timeoutMs });
        return { found: true };
      case "waitForNavigation":
        await page.waitForNavigation({
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
        });
        return { navigated: true, url: normalizeUrl(page.url()) };
      case "waitForTimeout":
        await page.waitForTimeout(command.params.time);
        return { waitedMs: command.params.time };
      case "waitForRequest": {
        const request = await page.waitForRequest(
          (candidate) =>
            (!command.params.url ||
              candidate.url().includes(command.params.url)) &&
            (!command.params.method ||
              candidate.method() === command.params.method.toUpperCase()),
          { timeout: timeoutMs },
        );
        return { url: request.url(), method: request.method() };
      }
      case "waitForResponse": {
        const response = await page.waitForResponse(
          (candidate) =>
            (!command.params.url ||
              candidate.url().includes(command.params.url)) &&
            (!command.params.statuses ||
              command.params.statuses.includes(candidate.status())),
          { timeout: timeoutMs },
        );
        return { url: response.url(), status: response.status() };
      }
      case "liveURL":
        return {
          inspector: `/v1/sessions/${session.id}/inspect`,
          screenshot: `/v1/sessions/${session.id}/inspect/screenshot`,
          policy:
            "OpenBrowse provides authenticated read-only inspection, not a public live-control URL.",
        };
      case "close":
        await sessions.close(session.id);
        await storage.deleteSession(session.id);
        return { closed: true };
    }
  };
  return { executeAgentCommand };
}

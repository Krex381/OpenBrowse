import { fetch as undiciFetch } from "undici";
import { config } from "./config.js";
import { pinnedAgent } from "./execution/http.js";
import { egressProxyAgent } from "./execution/shared.js";
import { resolveSafeUrl } from "./security.js";

export type OperationalAlert =
  | "queue"
  | "rejection"
  | "timeout"
  | "error"
  | "health-failure";

const endpointFor: Record<OperationalAlert, string> = {
  queue: config.queueAlertUrl,
  rejection: config.rejectAlertUrl,
  timeout: config.timeoutAlertUrl,
  error: config.errorAlertUrl,
  "health-failure": config.failedHealthUrl,
};
const lastSent = new Map<OperationalAlert, number>();

/** Fire-and-forget Browserless-style operator alert with a one-minute per-event cooldown. */
export async function notifyOperationalAlert(
  event: OperationalAlert,
  details: Record<string, string | number | boolean | undefined> = {},
): Promise<void> {
  const endpoint = endpointFor[event];
  const now = Date.now();
  if (!endpoint || now - (lastSent.get(event) ?? 0) < 60000) return;
  lastSent.set(event, now);
  const dispatcher = egressProxyAgent();
  let directDispatcher: ReturnType<typeof pinnedAgent> | undefined;
  try {
    const checked = await resolveSafeUrl(endpoint);
    const target = checked.url;
    directDispatcher = dispatcher ? undefined : pinnedAgent(checked.addresses);
    target.searchParams.set("event", event);
    for (const [key, value] of Object.entries(details))
      if (value !== undefined)
        target.searchParams.set(key, String(value).slice(0, 512));
    await undiciFetch(target, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
      redirect: "error",
      dispatcher: dispatcher ?? directDispatcher,
    });
  } catch {
    // Alerts must never block or fail browser work; operator telemetry is best effort.
  } finally {
    await dispatcher?.close();
    await directDispatcher?.close();
  }
}

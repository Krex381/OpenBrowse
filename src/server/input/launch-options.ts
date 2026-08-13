import { z } from "zod";
import { config } from "../../config.js";
import type { SafeLaunchOptions } from "../../cdp.js";
import { OpenBrowseError } from "../../errors.js";
import { parse } from "./validation.js";

const clientLaunchSchema = z
  .object({
    args: z.array(z.string().min(1).max(512)).max(30).optional(),
    headless: z.boolean().optional(),
    slowMo: z.number().int().min(0).max(5000).optional(),
    acceptInsecureCerts: z.boolean().optional(),
    ignoreHTTPSErrors: z.boolean().optional(),
  })
  .strict();
const unsafeChromiumArgumentPrefixes = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--remote-debugging-address",
  "--remote-debugging-port",
  "--user-data-dir",
  "--proxy-server",
  "--proxy-bypass-list",
  "--host-resolver-rules",
  "--disable-web-security",
  "--allow-file-access-from-files",
  "--disable-features=IsolateOrigins",
];
const permittedChromiumArgumentPatterns = [
  /^--window-size=\d{2,4},\d{2,4}$/,
  /^--lang=[A-Za-z0-9-]{2,35}$/,
  /^--(?:disable|enable)-features=[A-Za-z0-9,._-]{1,500}$/,
  /^--force-color-profile=[A-Za-z0-9-]{1,50}$/,
  /^--force-device-scale-factor=(?:[0-2](?:\.\d+)?|3(?:\.0+)?)$/,
  /^--font-render-hinting=(?:none|slight|medium|full)$/,
  /^--use-angle=[A-Za-z0-9_-]{1,32}$/,
  /^--(?:disable-gpu|disable-dev-shm-usage|mute-audio)$/,
];

export function parseClientLaunchOptions(
  query: Record<string, unknown>,
): SafeLaunchOptions {
  const launchValue = query.launch;
  const headlessValue = query.headless;
  if (launchValue === undefined && headlessValue === undefined) return {};
  if (!config.allowClientLaunchOptions)
    throw new OpenBrowseError(
      "FEATURE_DISABLED",
      "Client launch options are disabled; set OPENBROWSE_ALLOW_CLIENT_LAUNCH_OPTIONS=true to enable the hardened subset",
      403,
    );
  if (launchValue !== undefined && typeof launchValue !== "string")
    throw new OpenBrowseError(
      "INVALID_REQUEST",
      "launch must be a JSON or base64 JSON string",
      400,
    );
  let decoded: unknown = {};
  if (typeof launchValue === "string") {
    if (launchValue.length > 12000)
      throw new OpenBrowseError("INVALID_REQUEST", "launch is too large", 400);
    try {
      decoded = JSON.parse(launchValue);
    } catch {
      try {
        decoded = JSON.parse(
          Buffer.from(launchValue, "base64").toString("utf8"),
        );
      } catch {
        throw new OpenBrowseError(
          "INVALID_REQUEST",
          "launch must contain valid JSON",
          400,
        );
      }
    }
  }
  const options = parse(clientLaunchSchema, decoded);
  let queryHeadless: boolean | undefined;
  if (headlessValue !== undefined) {
    if (headlessValue === "true" || headlessValue === "1") queryHeadless = true;
    else if (headlessValue === "false" || headlessValue === "0")
      queryHeadless = false;
    else
      throw new OpenBrowseError(
        "INVALID_REQUEST",
        "headless must be true or false",
        400,
      );
  }
  for (const arg of options.args ?? []) {
    const normalized = arg.toLowerCase();
    if (
      unsafeChromiumArgumentPrefixes.some((prefix) =>
        normalized.startsWith(prefix),
      )
    )
      throw new OpenBrowseError(
        "FORBIDDEN",
        `Unsafe Chromium launch argument is not permitted: ${arg.split("=", 1)[0]}`,
        403,
      );
    if (!permittedChromiumArgumentPatterns.some((pattern) => pattern.test(arg)))
      throw new OpenBrowseError(
        "INVALID_REQUEST",
        `Unsupported Chromium launch argument: ${arg.split("=", 1)[0]}`,
        400,
      );
  }
  return {
    ...(options.args ? { args: options.args } : {}),
    ...(queryHeadless !== undefined
      ? { headless: queryHeadless }
      : options.headless !== undefined
        ? { headless: options.headless }
        : {}),
    ...(options.slowMo !== undefined ? { slowMo: options.slowMo } : {}),
    ...(options.acceptInsecureCerts !== undefined ||
    options.ignoreHTTPSErrors !== undefined
      ? {
          acceptInsecureCerts:
            options.acceptInsecureCerts ?? options.ignoreHTTPSErrors,
        }
      : {}),
  };
}

import { createHash } from "node:crypto";

export interface ApiKeyPolicy {
  name: string;
  allowedRoutes: string[];
  rateLimitPerMinute?: number;
  dailyRequestLimit?: number;
}

export function apiKeyPolicies(): {
  keys: string[];
  policies: Map<string, ApiKeyPolicy>;
} {
  const raw = process.env.OPENBROWSE_API_KEY_POLICIES;
  if (!raw?.trim()) return { keys: [], policies: new Map() };
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error("OPENBROWSE_API_KEY_POLICIES must be valid JSON");
  }
  if (!Array.isArray(decoded) || decoded.length > 100)
    throw new Error(
      "OPENBROWSE_API_KEY_POLICIES must be an array of at most 100 policies",
    );
  const policies = new Map<string, ApiKeyPolicy>();
  const keys: string[] = [];
  for (const [index, value] of decoded.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(
        `OPENBROWSE_API_KEY_POLICIES[${index}] must be an object`,
      );
    const item = value as Record<string, unknown>;
    if (
      typeof item.key !== "string" ||
      !item.key.trim() ||
      item.key.length > 512
    )
      throw new Error(
        `OPENBROWSE_API_KEY_POLICIES[${index}].key must be a non-empty string up to 512 characters`,
      );
    const routes = item.allowedRoutes ?? [];
    if (
      !Array.isArray(routes) ||
      routes.length > 100 ||
      !routes.every(
        (route) =>
          typeof route === "string" && /^\/[A-Za-z0-9_./-]*\*?$/.test(route),
      )
    )
      throw new Error(
        `OPENBROWSE_API_KEY_POLICIES[${index}].allowedRoutes must contain absolute routes, optionally ending in /*`,
      );
    for (const route of routes)
      if (route.includes("*") && !route.endsWith("/*"))
        throw new Error(
          `OPENBROWSE_API_KEY_POLICIES[${index}].allowedRoutes wildcards may only appear as a final /*`,
        );
    const number = (
      field: "rateLimitPerMinute" | "dailyRequestLimit",
      min: number,
      max: number,
    ) => {
      const input = item[field];
      if (input === undefined) return undefined;
      if (
        typeof input !== "number" ||
        !Number.isSafeInteger(input) ||
        input < min ||
        input > max
      )
        throw new Error(
          `OPENBROWSE_API_KEY_POLICIES[${index}].${field} must be an integer from ${min} to ${max}`,
        );
      return input;
    };
    const hash = createHash("sha256").update(item.key).digest("hex");
    if (policies.has(hash))
      throw new Error("OPENBROWSE_API_KEY_POLICIES contains duplicate keys");
    keys.push(item.key);
    policies.set(hash, {
      name:
        typeof item.name === "string" && item.name.trim()
          ? item.name.trim().slice(0, 128)
          : `key-${index + 1}`,
      allowedRoutes: routes as string[],
      rateLimitPerMinute: number("rateLimitPerMinute", 1, 100000),
      dailyRequestLimit: number("dailyRequestLimit", 0, 100000000),
    });
  }
  return { keys, policies };
}

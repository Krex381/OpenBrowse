const supported = new Set([
  "playwright-chromium",
  "patchright-chromium",
  "cloakbrowser-chromium",
  "camoufox-firefox",
  "clearcote-chromium",
]);
const requested = (
  process.env.OPENBROWSE_VERIFY_BROWSER_BACKENDS ?? "patchright-chromium"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const target = process.env.OPENBROWSE_VERIFY_TARGET ?? "https://example.com";
const allowFallback =
  process.env.OPENBROWSE_VERIFY_ALLOW_FALLBACK?.toLowerCase() === "true";
const allowChallenge =
  process.env.OPENBROWSE_VERIFY_ALLOW_CHALLENGE?.toLowerCase() === "true";

if (requested.length === 0 || requested.some((backend) => !supported.has(backend))) {
  throw new Error(
    `OPENBROWSE_VERIFY_BROWSER_BACKENDS must contain supported backend IDs; received '${requested.join(",")}'`,
  );
}

process.env.OPENBROWSE_API_KEYS ??= "backend-verify-key";
process.env.OPENBROWSE_ENCRYPTION_KEY ??=
  "backend-verifier-only-encryption-key-32-bytes";
process.env.OPENBROWSE_BROWSER_BACKENDS ??= requested.join(",");
process.env.OPENBROWSE_DEFAULT_BROWSER_BACKEND ??= requested[0];
process.env.OPENBROWSE_BROWSER_POOL_MIN ??= "0";
process.env.OPENBROWSE_DATA_DIR ??= "./data/backend-verify";
if (process.platform === "win32")
  process.env.OPENBROWSE_CHROMIUM_SANDBOX ??= "false";

const { buildServer } = await import("../dist/server.js");
const services = await buildServer();
const results = [];

try {
  for (const backend of requested) {
    const response = await services.app.inject({
      method: "POST",
      url: "/v1/fetch",
      headers: {
        authorization: `Bearer ${process.env.OPENBROWSE_API_KEYS.split(",")[0]}`,
      },
      payload: {
        url: target,
        strategy: "browser",
        browserBackend: backend,
        ...(backend === "cloakbrowser-chromium"
          ? {
              browserOptions: {
                fingerprintArgs: ["--fingerprint=381204"],
                humanize: true,
                humanPreset: "careful",
              },
            }
          : backend === "camoufox-firefox"
            ? {
                browserOptions: {
                  camoufox: {
                    humanize: true,
                    os: process.platform === "win32" ? "windows" : "linux",
                  },
                },
              }
            : backend === "clearcote-chromium"
              ? {
                  browserOptions: {
                    fingerprintArgs: ["--fingerprint=openbrowse-verify"],
                  },
                }
            : allowFallback
              ? {
                  browserOptions: {
                    fingerprintArgs: ["--fingerprint=381204"],
                    humanize: true,
                    humanPreset: "careful",
                    camoufox: { humanize: true },
                  },
                }
          : {}),
        output: ["text"],
        cache: { mode: "reload", ttlSeconds: 1 },
      },
    });
    const body = response.json();
    const selectedBackend = body.execution?.selectedBackend;
    if (
      response.statusCode !== 200 ||
      (!allowFallback && selectedBackend !== backend) ||
      (allowFallback && !supported.has(selectedBackend)) ||
      (!allowChallenge && body.execution?.challengeRemaining === true) ||
      typeof body.text !== "string" ||
      body.text.trim().length === 0
    ) {
      throw new Error(
        `${backend} verification failed (${response.statusCode}): ${JSON.stringify(body)}`,
      );
    }
    results.push({
      backend,
      selectedBackend,
      status: body.status,
      finalUrl: body.finalUrl,
      browserMs: body.execution?.timings?.browserMs,
      backendAttempts: body.execution?.backendAttempts,
      challengeRemaining: body.execution?.challengeRemaining,
      configuration: body.execution.backendConfiguration ?? null,
    });
  }
} finally {
  await services.close();
}

process.stdout.write(`${JSON.stringify({ verified: results }, null, 2)}\n`);

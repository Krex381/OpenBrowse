import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENBROWSE_API_KEYS ??= "challenge-handoff-verify-key";
process.env.OPENBROWSE_ENCRYPTION_KEY ??=
  "challenge-handoff-verifier-encryption-key-32-bytes";
let temporaryDataDir;
if (!process.env.OPENBROWSE_DATA_DIR) {
  temporaryDataDir = await mkdtemp(
    join(tmpdir(), "openbrowse-challenge-handoff-"),
  );
  process.env.OPENBROWSE_DATA_DIR = temporaryDataDir;
}
process.env.OPENBROWSE_BROWSER_POOL_MIN ??= "0";
if (process.platform === "win32")
  process.env.OPENBROWSE_CHROMIUM_SANDBOX ??= "false";

const target = process.env.OPENBROWSE_VERIFY_TARGET ?? "https://turt.pics/";
const { buildServer } = await import("../dist/server.js");
const services = await buildServer();
const headers = {
  authorization: `Bearer ${process.env.OPENBROWSE_API_KEYS.split(",")[0]}`,
};

try {
  const created = await services.app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers,
    payload: { ttlSeconds: 120, startUrl: target },
  });
  const body = created.json();
  if (created.statusCode !== 200)
    throw new Error(`Session creation failed: ${JSON.stringify(body)}`);
  const state = await services.app.inject({
    method: "GET",
    url: `/v1/sessions/${body.id}/challenge`,
    headers,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        target,
        navigation: body.navigation,
        challenge: state.json(),
      },
      null,
      2,
    )}\n`,
  );
  await services.app.inject({
    method: "DELETE",
    url: `/v1/sessions/${body.id}`,
    headers,
  });
} finally {
  await services.close();
  if (temporaryDataDir)
    await rm(temporaryDataDir, { recursive: true, force: true });
}

import { firefox } from "playwright";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";

const base = process.env.OPENBROWSE_VERIFY_URL ?? "http://127.0.0.1:3000";
const wsBase = base.replace(/^http/, "ws");
const key = process.env.OPENBROWSE_VERIFY_KEY ?? "dev-key";

async function waitForReady() {
  const deadline = Date.now() + 30000;
  let lastFailure = "health endpoint did not respond";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/healthz`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return;
      lastFailure = `health endpoint returned HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`OpenBrowse did not become ready within 30 seconds: ${lastFailure}`);
}

function dockerLogs() {
  if (process.env.OPENBROWSE_VERIFY_DOCKER_LOGS === "0") return "";
  try {
    const output = execFileSync(
      "docker",
      ["compose", "logs", "--no-color", "--tail", "100", "openbrowse"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return output ? `\n\nContainer logs:\n${output}` : "";
  } catch {
    return "\n\nContainer logs were unavailable (run `docker compose logs --tail=100 openbrowse`).";
  }
}

async function request(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!response.ok) {
    const error = json?.error;
    const details = error?.details ? ` (${JSON.stringify(error.details)})` : "";
    const fallback = text ? `: ${text.slice(0, 500)}` : "";
    throw new Error(
      `${path}: HTTP ${response.status} [${error?.code ?? "UNKNOWN"}] ${error?.message || fallback || "Request failed"}${details}${dockerLogs()}`,
    );
  }
  return json;
}

async function releaseSession(id) {
  try {
    const response = await fetch(`${base}/v1/sessions/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok)
      console.error(
        `Could not release verification session ${id}: HTTP ${response.status}`,
      );
  } catch (error) {
    console.error(
      `Could not release verification session ${id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertVncHandshake(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(
      () => reject(new Error("VNC handshake timed out")),
      15000,
    );
    socket.on("message", (data) => {
      const greeting = String(data);
      clearTimeout(timeout);
      socket.close();
      if (!greeting.startsWith("RFB "))
        reject(new Error("VNC bridge did not return an RFB greeting"));
      else resolve();
    });
    socket.on("error", reject);
  });
}

async function assertRawBridgeDisabled() {
  const response = await fetch(
    `${base}/firefox/playwright?token=${encodeURIComponent(key)}`,
  );
  if (response.status !== 404)
    throw new Error(
      `Raw Playwright bridge should be disabled by default, received HTTP ${response.status}`,
    );
}

let session;
let rawBridge;
try {
  await waitForReady();
  session = await request("/v1/sessions", {
    ttlSeconds: 120,
    liveViewer: true,
  });
  await request(`/v1/sessions/${session.id}/navigate`, {
    url: "https://example.com",
  });
  await assertVncHandshake(
    `${wsBase}/v1/sessions/${session.id}/vnc?token=${encodeURIComponent(key)}`,
  );

  if (process.env.OPENBROWSE_VERIFY_RAW_BRIDGES === "true") {
    const browser = await firefox.connect(
      `${wsBase}/firefox/playwright?token=${encodeURIComponent(key)}&timeout=30000`,
    );
    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
      if (!(await page.title()))
        throw new Error("Firefox page did not load a title");
    } finally {
      await browser.close();
    }
    rawBridge = "native Firefox Playwright verified";
  } else {
    await assertRawBridgeDisabled();
    rawBridge = "disabled by operator policy";
  }
} finally {
  if (session) await releaseSession(session.id);
}

console.log(
  JSON.stringify({
    vnc: "RFB handshake verified",
    rawBridge,
  }),
);

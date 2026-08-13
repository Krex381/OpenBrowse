import WebSocket from "ws";

const base = process.env.OPENBROWSE_VERIFY_URL ?? "http://127.0.0.1:3001";
const call = async (path, key, body, method = "POST") => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json() };
};
const wsCheck = (url, id) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  const timer = setTimeout(() => reject(new Error("CDP response timed out")), 10000);
  socket.on("open", () => socket.send(JSON.stringify({ id, method: "Browser.getVersion" })));
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.id === id) {
      clearTimeout(timer);
      socket.close();
      resolve(Boolean(message.result?.product));
    }
  });
  socket.on("error", reject);
});

const lighthouse = await call("/performance?token=dev-key", "dev-key", {
  url: "https://example.com",
  engine: "lighthouse",
  config: { settings: { onlyCategories: ["performance"] } },
});
const cdp = await call("/v1/cdp/sessions", "dev-key", { ttlSeconds: 60 });
const cdpUrl = `ws://127.0.0.1:3001/v1/cdp/sessions/${cdp.json.id}?accessToken=${encodeURIComponent(cdp.json.accessToken)}&token=dev-key`;
const reconnect = [await wsCheck(cdpUrl, 1), await wsCheck(cdpUrl, 2)];
const created = await call("/v1/sessions", "dev-key", { ttlSeconds: 60 });
const grant = await call(`/v1/sessions/${created.json.id}/handoff`, "dev-key", { ttlSeconds: 60 });
const redeemed = await call("/v1/sessions/handoff", "other-key", { token: grant.json.token });
const former = await call(`/v1/sessions/${created.json.id}`, "dev-key", undefined, "GET");
const newOwner = await call(`/v1/sessions/${created.json.id}`, "other-key", undefined, "GET");
const query = 'mutation { goto(url: "https://example.com") { finalUrl } network(captureBodies: true) { responses { url status contentType body bodyTruncated } } }';
const bql = await call("/chromium/bql?token=dev-key", "dev-key", { query });
const ui = await Promise.all(["/browserql", "/viewer"].map(async (path) => [path, (await fetch(`${base}${path}`)).status]));
console.log(JSON.stringify({
  lighthouse: { status: lighthouse.status, engine: lighthouse.json.engine, categories: Object.keys(lighthouse.json.audits?.categories ?? {}), artifact: Boolean(lighthouse.json.rawReport?.artifactId) },
  cdp: { created: cdp.status, reconnect },
  handoff: { redeemed: redeemed.status, former: former.status, newOwner: newOwner.status },
  bql: { status: bql.status, responses: bql.json.data?.network?.responses?.length, bodies: bql.json.data?.network?.responses?.filter((response) => typeof response.body === "string").length },
  ui: Object.fromEntries(ui),
}, null, 2));

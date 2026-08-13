import { z } from "zod";
import { config } from "../../../config.js";
import { OpenBrowseError } from "../../../errors.js";
import { normalizeUrl } from "../../../security.js";
import { parse } from "../../input.js";
import { sendBinary } from "../../presentation.js";
import type { SessionRouteDeps } from "./lifecycle.js";

export function registerSessionInspectionRoutes(input: SessionRouteDeps): void {
  const { app, storage, sessions, resolveProxy, requestKeyHash } = input;
  app.get("/v1/sessions/:id", async (request) => {
    const id = parse(z.object({ id: z.string() }), request.params).id;
    const session = storage.getSession(id);
    if (!session)
      throw new OpenBrowseError(
        "SESSION_NOT_FOUND",
        "Session does not exist or has expired",
        404,
      );
    return {
      id: session.id,
      state: "idle",
      persistent: session.persistent,
      createdAt: new Date(session.createdAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      pages: 1,
    };
  });
  app.get("/v1/sessions/:id/inspect", async (request) => {
    const id = parse(z.object({ id: z.string() }), request.params).id;
    const session = storage.getSession(id);
    if (!session)
      throw new OpenBrowseError(
        "SESSION_NOT_FOUND",
        "Session does not exist or has expired",
        404,
      );
    const live = await sessions.get(
      session,
      await resolveProxy(session.proxyId, requestKeyHash(request)),
    );
    return {
      id,
      active: true,
      tracing: sessions.isTracing(id),
      url: normalizeUrl(live.page.url()),
      title: await live.page.title().catch(() => ""),
      viewport: session.viewport,
      screenshotPath: `/v1/sessions/${id}/inspect/screenshot`,
      streamPath: `/v1/sessions/${id}/inspect/stream`,
      ...(session.liveViewer ? { vncPath: `/v1/sessions/${id}/vnc` } : {}),
    };
  });
  app.get("/v1/sessions/:id/inspect/screenshot", async (request, reply) => {
    const id = parse(z.object({ id: z.string() }), request.params).id;
    const session = storage.getSession(id);
    if (!session)
      throw new OpenBrowseError(
        "SESSION_NOT_FOUND",
        "Session does not exist or has expired",
        404,
      );
    const live = await sessions.get(
      session,
      await resolveProxy(session.proxyId, requestKeyHash(request)),
    );
    const image = await live.page.screenshot({ type: "png", fullPage: false });
    if (image.length > config.maxResponseBytes)
      throw new OpenBrowseError(
        "PAYLOAD_TOO_LARGE",
        "Session inspector frame exceeds the configured byte limit",
        413,
      );
    return sendBinary(reply, image, "image/png", request.id);
  });
  app.get("/v1/sessions/:id/inspect/stream", async (request, reply) => {
    const id = parse(z.object({ id: z.string() }), request.params).id;
    const query = parse(
      z.object({
        intervalMs: z.coerce.number().int().min(250).max(10000).default(1000),
        maxFrames: z.coerce.number().int().min(1).max(240).default(60),
      }),
      request.query,
    );
    const session = storage.getSession(id);
    if (!session)
      throw new OpenBrowseError(
        "SESSION_NOT_FOUND",
        "Session does not exist or has expired",
        404,
      );
    const live = await sessions.get(
      session,
      await resolveProxy(session.proxyId, requestKeyHash(request)),
    );
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let frame = 0;
    let running = false;
    let closed = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    const send = (event: string, value: unknown) => {
      if (!closed)
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
    };
    const capture = async () => {
      if (running || closed) return;
      running = true;
      try {
        const image = await live.page.screenshot({
          type: "jpeg",
          quality: 70,
          fullPage: false,
        });
        if (image.length > config.maxResponseBytes) {
          send("error", {
            code: "PAYLOAD_TOO_LARGE",
            message: "Inspector stream frame exceeds the configured byte limit",
          });
          close();
          return;
        }
        frame += 1;
        send("frame", {
          index: frame,
          timestamp: new Date().toISOString(),
          url: normalizeUrl(live.page.url()),
          title: await live.page.title().catch(() => ""),
          mimeType: "image/jpeg",
          imageBase64: image.toString("base64"),
        });
        if (frame >= query.maxFrames) close();
      } catch {
        send("error", {
          code: "SESSION_STREAM_FAILED",
          message: "Could not capture a session inspector frame",
        });
        close();
      } finally {
        running = false;
      }
    };
    reply.raw.on("close", close);
    await capture();
    if (!closed) timer = setInterval(() => void capture(), query.intervalMs);
  });
}

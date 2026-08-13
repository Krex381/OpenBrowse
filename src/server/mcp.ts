import { config } from "../config.js";
import { OpenBrowseError } from "../errors.js";

export const mcpTools = [
  {
    name: "browserless_agent",
    description:
      "Stateful, snapshot-driven browser agent. Create or resume an API-key-owned session and execute bounded browser commands; the MCP client supplies reasoning between snapshots.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Omit to create a new stateful session.",
        },
        ttlSeconds: {
          type: "integer",
          minimum: 60,
          maximum: config.maxSessionTtlSeconds,
        },
        persistent: { type: "boolean" },
        commands: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              method: {
                type: "string",
                enum: [
                  "goto",
                  "back",
                  "forward",
                  "reload",
                  "snapshot",
                  "text",
                  "html",
                  "evaluate",
                  "click",
                  "type",
                  "select",
                  "checkbox",
                  "hover",
                  "scroll",
                  "waitForSelector",
                  "waitForNavigation",
                  "waitForTimeout",
                  "waitForRequest",
                  "waitForResponse",
                  "liveURL",
                  "close",
                ],
              },
              params: { type: "object" },
            },
            required: ["method"],
          },
        },
      },
      required: ["commands"],
    },
    annotations: { openWorldHint: true },
  },
  {
    name: "openbrowse_fetch",
    description:
      "Fetch a public HTTP(S) page through OpenBrowse's HTTP-first browser gateway.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        strategy: { type: "string", enum: ["auto", "http", "browser"] },
        output: {
          type: "array",
          items: { type: "string", enum: ["html", "markdown", "links"] },
        },
      },
      required: ["url"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "openbrowse_extract",
    description: "Extract named CSS-selector fields from a public web page.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        selectors: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              selector: { type: "string" },
              type: { type: "string", enum: ["text", "html", "attribute"] },
              attribute: { type: "string" },
              all: { type: "boolean" },
            },
            required: ["selector", "type"],
          },
        },
      },
      required: ["url", "selectors"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "openbrowse_map",
    description: "Discover bounded same-origin links from a public site.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        maxUrls: { type: "integer", minimum: 1, maximum: 1000 },
        maxDepth: { type: "integer", minimum: 0, maximum: 10 },
      },
      required: ["url"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "openbrowse_screenshot",
    description: "Capture a PNG screenshot of a public page.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        fullPage: { type: "boolean" },
      },
      required: ["url"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
] as const;

export type McpId = string | number | null;
export const mcpReply = (id: McpId, result: unknown) => ({
  jsonrpc: "2.0",
  id,
  result,
});
export const mcpError = (
  id: McpId,
  code: number,
  message: string,
  data?: unknown,
) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});
export const mcpText = (value: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: isError ? undefined : value,
  ...(isError ? { isError: true } : {}),
});

export function validateMcpOrigin(request: {
  headers: Record<string, string | string[] | undefined>;
  hostname: string;
}): void {
  const origin = request.headers.origin;
  if (!origin || Array.isArray(origin)) return;
  try {
    const parsed = new URL(origin);
    if (parsed.hostname !== request.hostname)
      throw new Error("origin mismatch");
  } catch {
    throw new OpenBrowseError(
      "FORBIDDEN",
      "MCP Origin must match the service host",
      403,
    );
  }
}

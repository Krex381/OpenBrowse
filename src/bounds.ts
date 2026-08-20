import { config } from "./config.js";
import { OpenBrowseError } from "./errors.js";

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null");
}

export function assertBoundedJson<T>(value: T, subject: string): T {
  if (jsonBytes(value) > config.maxResponseBytes)
    throw new OpenBrowseError(
      "PAYLOAD_TOO_LARGE",
      `${subject} exceeds the configured byte limit`,
      413,
    );
  return value;
}

export function boundedJsonText(
  value: unknown,
  subject: string,
  spacing?: number,
): string {
  const text = JSON.stringify(value, null, spacing) ?? "null";
  if (Buffer.byteLength(text) > config.maxResponseBytes)
    throw new OpenBrowseError(
      "PAYLOAD_TOO_LARGE",
      `${subject} exceeds the configured byte limit`,
      413,
    );
  return text;
}

export function assertBoundedBuffer<T extends Uint8Array>(
  value: T,
  subject: string,
): T {
  if (value.byteLength > config.maxResponseBytes)
    throw new OpenBrowseError(
      "PAYLOAD_TOO_LARGE",
      `${subject} exceeds the configured byte limit`,
      413,
    );
  return value;
}

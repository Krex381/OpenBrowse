import { z } from "zod";
import { OpenBrowseError } from "../../errors.js";

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new OpenBrowseError(
      "INVALID_REQUEST",
      "Request validation failed",
      400,
      false,
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    );
  return result.data;
}

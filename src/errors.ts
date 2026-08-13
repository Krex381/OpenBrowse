import type { FastifyError, FastifyInstance } from "fastify";

export class OpenBrowseError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly retryable = false,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function isOpenBrowseError(error: unknown): error is OpenBrowseError {
  return error instanceof OpenBrowseError;
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler(
    (error: FastifyError | OpenBrowseError, request, reply) => {
      const clientError =
        !isOpenBrowseError(error) &&
        typeof error.statusCode === "number" &&
        error.statusCode >= 400 &&
        error.statusCode < 500;
      const typed = isOpenBrowseError(error)
        ? error
        : new OpenBrowseError(
            error.validation || clientError
              ? "INVALID_REQUEST"
              : "INTERNAL_ERROR",
            error.validation || clientError
              ? "Request validation failed"
              : "Unexpected server error",
            error.validation || clientError ? (error.statusCode ?? 400) : 500,
            false,
          );
      request.log[typed.statusCode >= 500 ? "error" : "warn"](
        { err: error, code: typed.code },
        typed.message,
      );
      void reply.status(typed.statusCode).send({
        error: {
          code: typed.code,
          message: typed.message,
          requestId: request.id,
          retryable: typed.retryable,
          details: typed.details,
        },
      });
    },
  );
}

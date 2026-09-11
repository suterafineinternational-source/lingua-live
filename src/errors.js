export class AppError extends Error {
  constructor(status, code, message, { retriable = false, details } = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.retriable = retriable;
    this.details = details;
  }
}
export function errorPayload(error) {
  const known = error instanceof AppError;
  return {
    error: {
      code: known ? error.code : "INTERNAL_ERROR",
      message: known ? error.message : "An unexpected server error occurred.",
      retriable: known ? error.retriable : false,
      ...(known && error.details ? { details: error.details } : {}),
    },
  };
}

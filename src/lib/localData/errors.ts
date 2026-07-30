export class LocalDataError extends Error {
  readonly code:
    | "MISSING_ROOT"
    | "INVALID_ROOT"
    | "PATH_ESCAPE"
    | "INVALID_PROJECT"
    | "INVALID_ZONE"
    | "RAW_WRITE_FORBIDDEN"
    | "NOT_FOUND";

  constructor(
    code: LocalDataError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LocalDataError";
    this.code = code;
  }
}

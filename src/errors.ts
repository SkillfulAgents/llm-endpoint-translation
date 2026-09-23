export type TranslationErrorCode = "invalid_request_error" | "unsupported_parameter";

// Client-attributable input the target wire can't express; callers map it to a 400.
export class TranslationError extends Error {
  readonly code: TranslationErrorCode;

  constructor(code: TranslationErrorCode, message: string) {
    super(message);
    this.name = "TranslationError";
    this.code = code;
  }
}

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  message: string;
  /**
   * Stable machine-readable error code — only on errors thrown as a
   * CodedHttpException (e.g. 'WITHDRAWAL_CODE_WRONG'). Absent otherwise.
   */
  code?: string;
  /** A coded error's extra fields (e.g. `triesLeft`, `lockedUntil`). */
  [extra: string]: unknown;
}

// Mirrors the error envelope shape emitted by every Textral REST
// route. Throwing this from the client lets call sites catch on a
// single class regardless of the underlying transport / status.

export class TextralApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'TextralApiError';
  }
}

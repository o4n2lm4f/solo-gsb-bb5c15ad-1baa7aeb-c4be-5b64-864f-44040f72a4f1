/**
 * Structured application error that maps 1:1 to an HTTP response.
 */
export class HttpError extends Error {
  /**
   * @param {number} statusCode HTTP status code (400 / 416 / 422).
   * @param {string} code Stable machine-readable error code.
   * @param {string} message Human readable explanation.
   * @param {Record<string, unknown>} [details] Extra context echoed to the client.
   */
  constructor(statusCode, code, message, details = {}) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

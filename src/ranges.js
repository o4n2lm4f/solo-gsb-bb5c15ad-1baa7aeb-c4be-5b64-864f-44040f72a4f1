import parseRange from 'range-parser';
import { HttpError } from './httpError.js';

const SPEC_RE = /^\d*-\d*$/;

/**
 * Parse a `Range` request header against a resource of `size` bytes, following
 * RFC 9110 §14.1.2 byte-range rules:
 *
 *   - closed interval      bytes=0-499
 *   - open tail            bytes=500-   (last byte = size-1)
 *   - suffix range         bytes=-500   (last 500 bytes)
 *
 * Endpoints that overrun the resource are clamped to size-1. Syntactically
 * valid but unsatisfiable specs are dropped; a syntactically malformed header
 * yields 400.
 *
 * @param {string|undefined} header Raw Range header value.
 * @param {bigint} size Resource length in bytes.
 * @returns {{start: number, end: number}[]} Satisfiable, clamped specs in request order.
 * @throws {HttpError} 400 MALFORMED_RANGE / 400 UNSUPPORTED_RANGE_UNIT / 400 RANGE_HEADER_REQUIRED.
 */
export function parseByteRanges(header, size) {
  if (header === undefined || header === null || String(header).trim() === '') {
    throw new HttpError(400, 'RANGE_HEADER_REQUIRED', 'A Range request header is required.');
  }

  const raw = String(header).trim();
  const eq = raw.indexOf('=');

  // No "=" at all is not a valid ranges specifier -> malformed.
  if (eq === -1) {
    throw new HttpError(400, 'MALFORMED_RANGE', 'Range header must be of the form "bytes=<range-spec>".');
  }

  const unit = raw.slice(0, eq).trim();
  if (unit.toLowerCase() !== 'bytes') {
    throw new HttpError(
      400,
      'UNSUPPORTED_RANGE_UNIT',
      `Unsupported Range unit "${unit}"; only "bytes" is supported.`,
      { supportedUnit: 'bytes' },
    );
  }

  const specsPart = raw.slice(eq + 1);
  const specs = specsPart.split(',').map((spec) => spec.trim()).filter((spec) => spec !== '');

  if (specs.length === 0) {
    throw new HttpError(400, 'MALFORMED_RANGE', 'Range header contains no range specifications.');
  }

  // Strict structural validation of every spec up front. RFC grammar (SP allowed):
  //   byte-range-spec      = first-byte-pos "-" [last-byte-pos]
  //   suffix-byte-range    = "-" suffix-length
  for (const spec of specs) {
    if (!SPEC_RE.test(spec) || spec === '-') {
      throw new HttpError(400, 'MALFORMED_RANGE', `Malformed byte-range specification "${spec}".`);
    }
  }

  // RFC 9110 §14.1.2.1: if the suffix length is greater than the representation
  // length, the range is the entire representation. range-parser marks this -1
  // (unsatisfiable), so normalize before delegating.
  if (size > 0n) {
    for (let i = 0; i < specs.length; i += 1) {
      const spec = specs[i];
      if (spec.startsWith('-')) {
        const suffixLength = BigInt(spec.slice(1));
        if (suffixLength >= size) {
          specs[i] = '0-'; // covers the whole representation
        }
      }
    }
  }

  // Delegate numeric parsing, endpoint clamping and unsatisfiable-spec discarding.
  // range-parser: array -> ranges, -1 -> none satisfiable, -2 -> syntactically invalid.
  const result = parseRange(Number(size), `bytes=${specs.join(',')}`);

  if (result === -2) {
    throw new HttpError(400, 'MALFORMED_RANGE', 'Range header is syntactically invalid.');
  }
  if (result === -1) {
    return [];
  }
  return result.map((r) => ({ start: r.start, end: r.end }));
}

/**
 * Coalesce ranges that overlap or are adjacent (gap of zero bytes between them).
 * Segments are produced in canonical ascending byte order, so the result is
 * deterministic and independent of the order ranges were requested in.
 *
 * @param {{start: number, end: number}[]} ranges Clamped ranges in request order.
 * @returns {{start: number, end: number}[]} Ordered, non-overlapping segments.
 */
export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => (a.start - b.start) || (a.end - b.end));
  /** @type {{start: number, end: number}[]} */
  const merged = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    // Adjacent when range.start === last.end + 1, i.e. range.start <= last.end + 1.
    if (last !== undefined && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

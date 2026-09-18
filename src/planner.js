import { createHash } from 'node:crypto';
import config from './config.js';
import { HttpError } from './httpError.js';
import { mergeRanges } from './ranges.js';

/**
 * @typedef {Object} Segment
 * @property {number} index Zero-based position in the emitted response.
 * @property {number} start First byte offset (inclusive).
 * @property {number} end Last byte offset (inclusive).
 * @property {number} length Number of bytes, i.e. end - start + 1.
 * @property {string} contentRange RFC 9110 Content-Range value, e.g. "bytes 0-99/1000".
 * @property {Object} headers Headers for this part (single) / this multipart section.
 * @property {string} [multipartPrelude] Exact bytes preceding this section's body (multipart only).
 */

/**
 * Build a deterministic multipart boundary from the planned segments so the same
 * request input always yields the same boundary.
 *
 * @param {bigint} size
 * @param {{start:number,end:number}[]} merged
 * @param {string} mediaType
 * @returns {string}
 */
export function buildBoundary(size, merged, mediaType) {
  const basis = `${size}|${mediaType}|${merged.map((m) => `${m.start}-${m.end}`).join(',')}`;
  const digest = createHash('sha256').update(basis).digest('hex').slice(0, 32);
  return `----rangeplanner${digest}`;
}

/**
 * Compute the exact Content-Length of a multipart/byteranges payload by summing
 * delimiters, part header blocks and segment bodies.
 *
 * @param {string} boundary
 * @param {Segment[]} segments
 * @returns {number}
 */
function multipartContentLength(boundary, segments) {
  let total = 0n;
  for (const seg of segments) {
    total += BigInt(Buffer.byteLength(`--${boundary}\r\n`, 'ascii'));
    total += BigInt(Buffer.byteLength(seg.multipartPrelude, 'ascii'));
    total += BigInt(seg.length);
    total += BigInt(Buffer.byteLength('\r\n', 'ascii'));
  }
  total += BigInt(Buffer.byteLength(`--${boundary}--\r\n`, 'ascii'));
  return Number(total);
}

/**
 * Validate the requested resource length.
 *
 * @param {unknown} raw
 * @returns {bigint}
 */
export function parseSize(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new HttpError(400, 'SIZE_REQUIRED', 'The total resource size ("size") is required.');
  }
  if (
    typeof raw === 'boolean' ||
    (!Number.isInteger(raw) && !/^\d+$/.test(String(raw).trim()))
  ) {
    throw new HttpError(400, 'INVALID_SIZE', '"size" must be a non-negative integer number of bytes.');
  }
  const size = BigInt(raw);
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpError(400, 'INVALID_SIZE', `"size" must be between 0 and ${Number.MAX_SAFE_INTEGER}.`);
  }
  return size;
}

/**
 * Validate the optional media type used in (multipart) Content-Type headers.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function parseMediaType(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return 'application/octet-stream';
  }
  if (typeof raw !== 'string') {
    throw new HttpError(400, 'INVALID_CONTENT_TYPE', '"contentType" must be a string like "video/mp4".');
  }
  const value = raw.trim();
  if (/\r|\n/.test(value) || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:\s*;.*)?$/.test(value)) {
    throw new HttpError(400, 'INVALID_CONTENT_TYPE', `"contentType" value "${raw}" is not a valid media type.`);
  }
  return value;
}

/**
 * Turn satisfiable, clamped ranges into a complete response plan.
 *
 * Applies the abuse guards (HTTP 422) before coalescing, then emits either a
 * single-range 206 plan or a deterministic multipart/byteranges plan.
 *
 * @param {{start:number,end:number}[]} ranges Satisfiable clamped ranges (request order).
 * @param {bigint} size Total resource size.
 * @param {string} rangeHeader Echoed Range header value.
 * @param {string} mediaType Resource media type for planned Content-Type headers.
 * @returns {Object} A serializable response plan.
 */
export function buildPlan(ranges, size, rangeHeader, mediaType) {
  if (ranges.length === 0) {
    const contentRange = `bytes */${size.toString()}`;
    throw new HttpError(
      416,
      'RANGE_NOT_SATISFIABLE',
      'None of the requested byte ranges overlap the representation.',
      { contentRange, requestedRange: rangeHeader, resourceSize: Number(size) },
    );
  }

  // Guard 1: too many satisfiable ranges in one request (counted before merging,
  // so duplicated/overlapping ranges cannot be hidden by coalescing).
  if (ranges.length > config.maxRanges) {
    throw new HttpError(
      422,
      'TOO_MANY_RANGES',
      `Request contains ${ranges.length} ranges; the maximum allowed is ${config.maxRanges}.`,
      { rangeCount: ranges.length, maxRanges: config.maxRanges },
    );
  }

  // Guard 2: total planned bytes (before merging; duplicates/overlaps count) must
  // not exceed the resource size times MAX_BYTES_MULTIPLIER.
  const requestedBytes = ranges.reduce((acc, r) => acc + BigInt(r.end - r.start + 1), 0n);
  const maxBytes = size * BigInt(config.maxBytesMultiplier);
  if (size > 0n && requestedBytes > maxBytes) {
    throw new HttpError(
      422,
      'TRANSFER_TOO_LARGE',
      `Planned transfer of ${requestedBytes} bytes exceeds ${config.maxBytesMultiplier}x the resource size (${maxBytes} bytes).`,
      {
        plannedBytes: Number(requestedBytes),
        resourceSize: Number(size),
        multiplier: config.maxBytesMultiplier,
        limitBytes: Number(maxBytes),
      },
    );
  }

  const merged = mergeRanges(ranges);

  if (merged.length === 1) {
    const [{ start, end }] = merged;
    const length = end - start + 1;
    const contentRange = `bytes ${start}-${end}/${size.toString()}`;
    return {
      statusCode: 206,
      kind: 'single',
      resourceSize: Number(size),
      requestedRange: rangeHeader,
      rangeCountBeforeMerge: ranges.length,
      segments: [
        {
          index: 0,
          start,
          end,
          length,
          contentRange,
          headers: {
            'Content-Range': contentRange,
            'Accept-Ranges': 'bytes',
            'Content-Type': mediaType,
            'Content-Length': String(length),
          },
        },
      ],
      headers: {
        'Content-Range': contentRange,
        'Accept-Ranges': 'bytes',
        'Content-Type': mediaType,
        'Content-Length': String(length),
      },
      contentLength: length,
    };
  }

  const boundary = buildBoundary(size, merged, mediaType);
  const contentType = `multipart/byteranges; boundary=${boundary}`;

  /** @type {Segment[]} */
  const segments = merged.map((m, index) => {
    const length = m.end - m.start + 1;
    const contentRange = `bytes ${m.start}-${m.end}/${size.toString()}`;
    const multipartPrelude =
      `Content-Type: ${mediaType}\r\n` +
      `Content-Range: ${contentRange}\r\n\r\n`;
    return {
      index,
      start: m.start,
      end: m.end,
      length,
      contentRange,
      multipartPrelude,
      headers: {
        'Content-Type': mediaType,
        'Content-Range': contentRange,
      },
    };
  });

  const contentLength = multipartContentLength(boundary, segments);
  const overheadBytes =
    contentLength - segments.reduce((acc, seg) => acc + seg.length, 0);

  return {
    statusCode: 206,
    kind: 'multipart',
    resourceSize: Number(size),
    requestedRange: rangeHeader,
    rangeCountBeforeMerge: ranges.length,
    segments,
    multipart: {
      contentType,
      boundary,
      contentLength,
      overheadBytes,
      delimiter: `--${boundary}`,
      closingDelimiter: `--${boundary}--`,
      framing: [
        `--${boundary}\\r\\n`,
        'Content-Type: <mediaType>\\r\\n',
        'Content-Range: bytes <start>-<end>/<size>\\r\\n',
        '\\r\\n',
        '<segment bytes>',
        '\\r\\n',
        `--${boundary}--\\r\\n`,
      ].join('\n'),
    },
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType,
      'Content-Length': String(contentLength),
    },
    contentLength,
  };
}

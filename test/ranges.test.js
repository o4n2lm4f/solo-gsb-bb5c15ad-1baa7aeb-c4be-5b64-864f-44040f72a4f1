import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseByteRanges, mergeRanges } from '../src/ranges.js';

describe('parseByteRanges', () => {
  test('closed interval', () => {
    assert.deepEqual(parseByteRanges('bytes=0-499', 1000n), [{ start: 0, end: 499 }]);
  });

  test('open tail clamps to size-1', () => {
    assert.deepEqual(parseByteRanges('bytes=500-', 1000n), [{ start: 500, end: 999 }]);
    assert.deepEqual(parseByteRanges('bytes=0-', 1000n), [{ start: 0, end: 999 }]);
  });

  test('suffix range maps to last N bytes', () => {
    assert.deepEqual(parseByteRanges('bytes=-500', 1000n), [{ start: 500, end: 999 }]);
    assert.deepEqual(parseByteRanges('bytes=-1', 1000n), [{ start: 999, end: 999 }]);
  });

  test('end overrun is clamped', () => {
    assert.deepEqual(parseByteRanges('bytes=900-2000', 1000n), [{ start: 900, end: 999 }]);
  });

  test('suffix longer than resource covers entire resource (RFC 9110)', () => {
    assert.deepEqual(parseByteRanges('bytes=-2000', 1000n), [{ start: 0, end: 999 }]);
    assert.deepEqual(parseByteRanges('bytes=-1000', 1000n), [{ start: 0, end: 999 }]);
  });

  test('unsatisfiable specs return empty', () => {
    assert.deepEqual(parseByteRanges('bytes=1000-2000', 1000n), []);
    assert.deepEqual(parseByteRanges('bytes=1000-', 1000n), []);
    assert.deepEqual(parseByteRanges('bytes=10-5', 1000n), []);
  });

  test('unsatisfiable specs are dropped while valid ones remain', () => {
    assert.deepEqual(parseByteRanges('bytes=1000-2000,0-100', 1000n), [{ start: 0, end: 100 }]);
    assert.deepEqual(parseByteRanges('bytes=10-5,0-100,2000-', 1000n), [{ start: 0, end: 100 }]);
  });

  test('tolerates optional whitespace', () => {
    assert.deepEqual(parseByteRanges('bytes=0-499, 500-599', 1000n), [
      { start: 0, end: 499 },
      { start: 500, end: 599 },
    ]);
    assert.deepEqual(parseByteRanges('  bytes = 0-99  ', 1000n), [{ start: 0, end: 99 }]);
  });

  test('rejects missing or empty Range header', () => {
    assert.throws(() => parseByteRanges(undefined, 1000n), { code: 'RANGE_HEADER_REQUIRED' });
    assert.throws(() => parseByteRanges('   ', 1000n), { code: 'RANGE_HEADER_REQUIRED' });
  });

  test('rejects unsupported range unit', () => {
    assert.throws(() => parseByteRanges('items=0-10', 1000n), { code: 'UNSUPPORTED_RANGE_UNIT' });
  });

  test('rejects malformed specs with 400', () => {
    assert.throws(() => parseByteRanges('bytes=-', 1000n), { code: 'MALFORMED_RANGE' });
    assert.throws(() => parseByteRanges('bytes=a-b', 1000n), { code: 'MALFORMED_RANGE' });
    assert.throws(() => parseByteRanges('bytes=0-499,a-b', 1000n), { code: 'MALFORMED_RANGE' });
    assert.throws(() => parseByteRanges('bytes 0-499', 1000n), { code: 'MALFORMED_RANGE' });
  });

  test('zero-size resource rejects every range', () => {
    assert.deepEqual(parseByteRanges('bytes=0-0', 0n), []);
    assert.deepEqual(parseByteRanges('bytes=-1', 0n), []);
  });
});

describe('mergeRanges', () => {
  test('keeps disjoint ranges sorted', () => {
    assert.deepEqual(
      mergeRanges([{ start: 700, end: 999 }, { start: 0, end: 499 }]),
      [{ start: 0, end: 499 }, { start: 700, end: 999 }],
    );
  });

  test('merges overlapping ranges', () => {
    assert.deepEqual(
      mergeRanges([{ start: 0, end: 600 }, { start: 500, end: 999 }]),
      [{ start: 0, end: 999 }],
    );
  });

  test('merges adjacent ranges (gap of zero)', () => {
    assert.deepEqual(
      mergeRanges([{ start: 0, end: 499 }, { start: 500, end: 999 }]),
      [{ start: 0, end: 999 }],
    );
    assert.deepEqual(
      mergeRanges([{ start: 0, end: 499 }, { start: 499, end: 999 }]),
      [{ start: 0, end: 999 }],
    );
  });

  test('merges transitively overlapping ranges', () => {
    assert.deepEqual(
      mergeRanges([{ start: 0, end: 100 }, { start: 200, end: 300 }, { start: 90, end: 210 }]),
      [{ start: 0, end: 300 }],
    );
  });

  test('is order independent (deterministic)', () => {
    const a = mergeRanges([{ start: 500, end: 999 }, { start: 0, end: 600 }]);
    const b = mergeRanges([{ start: 0, end: 600 }, { start: 500, end: 999 }]);
    assert.deepEqual(a, b);
  });

  test('does not merge ranges separated by a gap', () => {
    assert.deepEqual(
      mergeRanges([{ start: 0, end: 498 }, { start: 500, end: 999 }]),
      [{ start: 0, end: 498 }, { start: 500, end: 999 }],
    );
  });
});

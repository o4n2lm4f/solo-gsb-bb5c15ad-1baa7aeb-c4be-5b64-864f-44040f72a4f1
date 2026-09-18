import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import buildApp from '../src/app.js';

const post = (app, body, headers = {}) =>
  app.inject({ method: 'POST', url: '/ranges/plan', headers, payload: body });

describe('POST /ranges/plan', () => {
  /** @type {import('fastify').FastifyInstance} */
  let app;
  before(async () => {
    app = buildApp();
    await app.ready();
  });

  test('single closed range returns 206 with single headers', async () => {
    const res = await post(app, { size: 1000 }, { Range: 'bytes=0-499' });
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.equal(res.headers['content-range'], 'bytes 0-499/1000');
    const body = res.json();
    assert.equal(body.kind, 'single');
    assert.equal(body.contentLength, 500);
    assert.deepEqual(body.segments[0].start, 0);
    assert.deepEqual(body.segments[0].end, 499);
    assert.equal(body.headers['Content-Length'], '500');
  });

  test('open tail and suffix ranges', async () => {
    const tail = await post(app, { size: 1000 }, { Range: 'bytes=900-' });
    assert.equal(tail.json().segments[0].contentRange, 'bytes 900-999/1000');

    const suffix = await post(app, { size: 1000 }, { Range: 'bytes=-100' });
    assert.equal(suffix.json().segments[0].contentRange, 'bytes 900-999/1000');

    const overSuffix = await post(app, { size: 1000 }, { Range: 'bytes=-5000' });
    assert.equal(overSuffix.statusCode, 206);
    assert.equal(overSuffix.json().segments[0].contentRange, 'bytes 0-999/1000');
  });

  test('all unsatisfiable returns 416 with Content-Range header', async () => {
    const res = await post(app, { size: 1000 }, { Range: 'bytes=2000-3000' });
    assert.equal(res.statusCode, 416);
    assert.equal(res.headers['content-range'], 'bytes */1000');
    const body = res.json();
    assert.equal(body.error, 'RANGE_NOT_SATISFIABLE');
    assert.equal(body.contentRange, 'bytes */1000');
  });

  test('partially satisfiable request keeps only valid specs', async () => {
    const res = await post(app, { size: 1000 }, { Range: 'bytes=5000-6000,0-100' });
    assert.equal(res.statusCode, 206);
    assert.equal(res.json().kind, 'single');
  });

  test('multipart plan has deterministic boundary and per-part headers', async () => {
    const h1 = { Range: 'bytes=0-99,900-999' };
    const h2 = { Range: 'bytes=900-999,0-99' };
    const r1 = await post(app, { size: 1000, contentType: 'video/mp4' }, h1);
    const r2 = await post(app, { size: 1000, contentType: 'video/mp4' }, h2);
    assert.equal(r1.statusCode, 206);
    const b1 = r1.json();
    const b2 = r2.json();
    assert.equal(b1.kind, 'multipart');
    assert.equal(b1.multipart.boundary, b2.multipart.boundary, 'boundary must be deterministic');
    assert.equal(b1.segments.length, 2);
    assert.equal(b1.segments[0].contentRange, 'bytes 0-99/1000');
    assert.equal(b1.segments[1].contentRange, 'bytes 900-999/1000');
    assert.equal(b1.segments[0].headers['Content-Type'], 'video/mp4');
    assert.match(b1.multipart.contentType, /^multipart\/byteranges; boundary=----rangeplanner[0-9a-f]{32}$/);
    // Exact framing length: 2 bodies + 2 per-part preludes + delimiters.
    const boundary = b1.multipart.boundary;
    const calc =
      Buffer.byteLength(`--${boundary}\r\n`) +
      Buffer.byteLength(b1.segments[0].multipartPrelude) + 100 + 2 +
      Buffer.byteLength(`--${boundary}\r\n`) +
      Buffer.byteLength(b1.segments[1].multipartPrelude) + 100 + 2 +
      Buffer.byteLength(`--${boundary}--\r\n`);
    assert.equal(b1.multipart.contentLength, calc);
    assert.equal(b1.headers['Content-Length'], String(calc));
  });

  test('overlapping/adjacent ranges coalesce into a single 206', async () => {
    const res = await post(app, { size: 1000 }, { Range: 'bytes=0-499,500-999' });
    const body = res.json();
    assert.equal(body.kind, 'single');
    assert.equal(body.segments[0].start, 0);
    assert.equal(body.segments[0].end, 999);
  });

  test('more than 16 satisfiable ranges returns 422', async () => {
    const specs = Array.from({ length: 17 }, (_, i) => `${i * 10}-${i * 10 + 5}`).join(',');
    const res = await post(app, { size: 1000 }, { Range: `bytes=${specs}` });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error, 'TOO_MANY_RANGES');
  });

  test('exactly 16 ranges is accepted', async () => {
    const specs = Array.from({ length: 16 }, (_, i) => `${i * 10}-${i * 10 + 5}`).join(',');
    const res = await post(app, { size: 1000 }, { Range: `bytes=${specs}` });
    assert.equal(res.statusCode, 206);
  });

  test('planned bytes over 2x resource returns 422', async () => {
    // Three full copies of the resource => 3000 bytes requested.
    const res = await post(app, { size: 1000 }, { Range: 'bytes=0-,0-,0-' });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error, 'TRANSFER_TOO_LARGE');
    assert.equal(res.json().plannedBytes, 3000);
  });

  test('exactly 2x resource is accepted', async () => {
    const res = await post(app, { size: 1000 }, { Range: 'bytes=0-,0-' });
    assert.equal(res.statusCode, 206);
    assert.equal(res.json().rangeCountBeforeMerge, 2);
  });

  test('400 on missing Range header', async () => {
    const res = await post(app, { size: 1000 });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'RANGE_HEADER_REQUIRED');
  });

  test('400 on malformed Range header', async () => {
    const res = await post(app, { size: 1000 }, { Range: 'bytes=a-b' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'MALFORMED_RANGE');
  });

  test('400 on unsupported unit', async () => {
    const res = await post(app, { size: 1000 }, { Range: 'items=0-10' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'UNSUPPORTED_RANGE_UNIT');
  });

  test('400 on missing/invalid size', async () => {
    const res1 = await post(app, {}, { Range: 'bytes=0-10' });
    assert.equal(res1.statusCode, 400);
    assert.equal(res1.json().error, 'SIZE_REQUIRED');

    const res2 = await post(app, { size: -5 }, { Range: 'bytes=0-10' });
    assert.equal(res2.statusCode, 400);
    assert.equal(res2.json().error, 'INVALID_SIZE');

    const res3 = await post(app, { size: 'abc' }, { Range: 'bytes=0-10' });
    assert.equal(res3.statusCode, 400);
    assert.equal(res3.json().error, 'INVALID_SIZE');
  });

  test('400 on invalid content type', async () => {
    const res = await post(app, { size: 1000, contentType: 'not-a-type\r\nX: y' }, { Range: 'bytes=0-10' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'INVALID_CONTENT_TYPE');
  });

  test('GET endpoint reads size from query string', async () => {
    const res = await app.inject({ method: 'GET', url: '/ranges/plan?size=1000', headers: { Range: 'bytes=0-9' } });
    assert.equal(res.statusCode, 206);
    assert.equal(res.json().contentLength, 10);
  });

  test('health and index routes', async () => {
    assert.equal((await app.inject('/healthz')).json().status, 'ok');
    assert.equal((await app.inject('/')).json().service, 'range-planner');
  });
});

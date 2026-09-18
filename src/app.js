import Fastify from 'fastify';
import config from './config.js';
import { HttpError } from './httpError.js';
import { parseByteRanges } from './ranges.js';
import { buildPlan, parseMediaType, parseSize } from './planner.js';

/**
 * Shared planning routine for GET and POST.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
function planHandler(request, reply) {
  const rawSize = request.method === 'POST'
    ? request.body?.size ?? request.body?.totalSize
    : request.query.size ?? request.query.totalSize;
  const rawMediaType = request.method === 'POST'
    ? request.body?.contentType
    : request.query.contentType;

  const size = parseSize(rawSize);
  const mediaType = parseMediaType(rawMediaType);
  const rangeHeader = request.headers.range;
  const ranges = parseByteRanges(rangeHeader, size);

  const plan = buildPlan(ranges, size, String(rangeHeader), mediaType);

  // Echo the headers that are safe to carry on a JSON planning response.
  // (The multipart Content-Type/Content-Length describe the planned entity, not
  // this JSON envelope, so they live exclusively in `plan.headers`.)
  reply.header('Accept-Ranges', 'bytes');
  if (plan.headers['Content-Range']) {
    reply.header('Content-Range', plan.headers['Content-Range']);
  }
  reply.status(206);
  return plan;
}

/**
 * Build the Fastify application (exported for tests).
 * @param {object} [opts]
 */
export default function buildApp(opts = {}) {
  const app = Fastify({ logger: opts.logger ?? false });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/', async () => ({
    service: 'range-planner',
    description: 'HTTP byte-range response planning API (RFC 9110)',
    usage: {
      post: {
        method: 'POST',
        path: '/ranges/plan',
        headers: { Range: 'bytes=0-499' },
        body: { size: 1000, contentType: 'video/mp4 (optional)' },
      },
      get: {
        method: 'GET',
        path: '/ranges/plan?size=1000',
        headers: { Range: 'bytes=0-499' },
      },
    },
    limits: { maxRanges: config.maxRanges, maxBytesMultiplier: config.maxBytesMultiplier },
  }));

  app.get('/ranges/plan', planHandler);
  app.post('/ranges/plan', planHandler);

  // Structured application errors.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      reply.header('Accept-Ranges', 'bytes');
      // RFC 9110: a 416 response must carry `Content-Range: bytes */<size>`.
      if (error.statusCode === 416 && error.details?.contentRange) {
        reply.header('Content-Range', error.details.contentRange);
      }
      return reply.status(error.statusCode).send({
        statusCode: error.statusCode,
        error: error.code,
        message: error.message,
        ...error.details,
      });
    }

    // Malformed JSON body or other Fastify errors.
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error(error);
      return reply.status(500).send({
        statusCode: 500,
        error: 'INTERNAL_ERROR',
        message: 'Unexpected server error.',
      });
    }
    return reply.status(statusCode).send({
      statusCode,
      error: error.code ?? 'BAD_REQUEST',
      message: error.message,
    });
  });

  return app;
}

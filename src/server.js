import buildApp from './app.js';
import config from './config.js';

const app = buildApp();

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`range-planner listening on http://${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

'use strict';

/**
 * KOVER.IA — Production runtime entry-point.
 *
 * Boots, in a single Node process:
 *   1. The HTTP dashboard (SSE log stream + static UI).
 *   2. The KoverEngine — the 6-stage flashloan interception pipeline
 *      defined in `src/engine.js`.
 *
 * Both share an in-process event bus (`src/eventBus.js`) so dashboard
 * delivery is sub-millisecond.
 *
 * Run:    npm start
 *         (or: node src/start.js)
 */

require('dotenv').config();

const dashboard = require('../dashboard/server');
const { fromEnv } = require('./engine');
const { logger } = require('./logger');

logger.info({ port: process.env.DASHBOARD_PORT || 8787 }, 'booting dashboard…');
dashboard.start();

logger.info('booting engine…');
const engine = fromEnv();

process.on('SIGINT',  () => engine.stop().finally(() => process.exit(130)));
process.on('SIGTERM', () => engine.stop().finally(() => process.exit(0)));
process.on('unhandledRejection', (reason) => logger.error({ reason: String(reason) }, 'unhandled'));

engine.start().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'engine boot failed');
  process.exit(1);
});

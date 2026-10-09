const config = require('./config');
const { logger } = require('./logger');
const { createApp } = require('./app');
const { migrate } = require('./migrate');
const { pool } = require('./db');
const { startScheduler } = require('./scheduler');

async function main() {
  if (config.runMigrations) await migrate();
  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info('server started', { port: config.port });
  });
  const scheduler = startScheduler();

  // ปิดอย่างเรียบร้อยเมื่อ docker stop / platform restart
  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    scheduler.stop();
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => logger.error('unhandledRejection', { err }));

main().catch((err) => {
  logger.error('startup failed', { err });
  process.exit(1);
});

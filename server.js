// server.js
import fs from 'fs';
import http from 'http';
import https from 'https';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import app from './app.js';
import { initializeSocket } from './socketServer.js';
import winston from 'winston';

dotenv.config({ path: './.env' });

// --- simple winston logger (customize transports in production) ---
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) =>
      `${timestamp} ${level}: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    // in production you can add file transports or other transports (e.g. CloudWatch)
    // new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
  ],
});

// --- Validate critical env vars early ---
const { DATABASE: DB, JWT_SECRET, NODE_ENV = 'development', PORT = 3000 } = process.env;
if (!DB) {
  logger.error('DATABASE environment variable is not defined!');
  process.exit(1);
}
if (!JWT_SECRET) {
  logger.error('JWT_SECRET environment variable is not defined!');
  process.exit(1);
}

// If behind a reverse proxy (NGINX, load balancer) enable trust proxy for secure cookies & rate limiter
if (NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// --- Mongoose connection with recommended options ---
mongoose
  .connect(DB, {
    // useNewUrlParser and useUnifiedTopology are deprecated in MongoDB driver 4.0+
    // MongoDB driver now handles these automatically
  })
  .then(() => logger.info('DB connection successful!'))
  .catch((err) => {
    logger.error('DB connection error:', err.message || err);
    process.exit(1);
  });

// --- Create HTTP or HTTPS server depending on env ---
// Provide full absolute paths to cert/key or use environment strings if you manage them that way.
let server;
try {
  const { SSL_KEY_PATH, SSL_CERT_PATH } = process.env;
  if (SSL_KEY_PATH && SSL_CERT_PATH && fs.existsSync(SSL_KEY_PATH) && fs.existsSync(SSL_CERT_PATH)) {
    logger.info('Starting HTTPS server');
    const key = fs.readFileSync(SSL_KEY_PATH, 'utf8');
    const cert = fs.readFileSync(SSL_CERT_PATH, 'utf8');
    const httpsOptions = { key, cert };
    server = https.createServer(httpsOptions, app);
  } else {
    logger.info('Starting HTTP server');
    server = http.createServer(app);
  }
} catch (err) {
  logger.error('Error creating server:', err);
  process.exit(1);
}

// Initialize Socket.IO (attach to server)
initializeSocket(server);

// start listening
server.listen(PORT, () => {
  logger.info(`App running on port ${PORT} (env=${NODE_ENV})...`);
});

// --- Graceful shutdown helpers ---
const shutdown = (signal, exitCode = 0) => {
  return async (err) => {
    if (err) logger.error(`${signal} triggered shutdown:`, err);
    else logger.info(`${signal} triggered shutdown`);

    // stop accepting new connections
    try {
      server.close(() => {
        logger.info('HTTP server closed');
      });

      // close mongoose connection
      await mongoose.connection.close(false);
      logger.info('MongoDB connection closed');

      // allow a short grace period for sockets to finish
      setTimeout(() => {
        logger.info('Exiting process');
        process.exit(exitCode);
      }, 1000).unref();
    } catch (closeErr) {
      logger.error('Error during shutdown', closeErr);
      process.exit(1);
    }
  };
};

// handle signals
process.on('SIGTERM', shutdown('SIGTERM', 0));
process.on('SIGINT', shutdown('SIGINT', 0));

// handle uncaught exceptions and unhandled promise rejections
process.on('uncaughtException', (err) => {
  logger.error('UNCAUGHT EXCEPTION! Shutting down...', err);
  // give logger a moment to flush
  shutdown('uncaughtException', 1)(err);
});

process.on('unhandledRejection', (err) => {
  logger.error('UNHANDLED REJECTION! Shutting down...', err);
  shutdown('unhandledRejection', 1)(err);
});

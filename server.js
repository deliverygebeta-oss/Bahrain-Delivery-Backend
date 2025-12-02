// server.js
import fs from 'fs';
import http from 'http';
import https from 'https';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import app from './app.js';
import { initializeSocket } from './socketServer.js';

dotenv.config({ path: './.env' });

// --- Validate critical env vars early ---
const { DATABASE: DB, JWT_SECRET, NODE_ENV = 'development', PORT = 4000 } = process.env;

if (!DB) {
  console.log('❌ ERROR: DATABASE environment variable is not defined!');
  process.exit(1);
}
if (!JWT_SECRET) {
  console.log('❌ ERROR: JWT_SECRET environment variable is not defined!');
  process.exit(1);
}

// If behind a reverse proxy (NGINX, load balancer) enable trust proxy
if (NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// --- Mongoose connection ---
mongoose
  .connect(DB)
  .then(() => console.log('✅ Database connected successfully!'))
  .catch((err) => {
    console.log('❌ Database connection error:', err.message);
    process.exit(1);
  });

// --- Create HTTP or HTTPS server ---
let server;
try {
  const { SSL_KEY_PATH, SSL_CERT_PATH } = process.env;
  if (SSL_KEY_PATH && SSL_CERT_PATH && fs.existsSync(SSL_KEY_PATH) && fs.existsSync(SSL_CERT_PATH)) {
    console.log('🔒 Starting HTTPS server...');
    const key = fs.readFileSync(SSL_KEY_PATH, 'utf8');
    const cert = fs.readFileSync(SSL_CERT_PATH, 'utf8');
    server = https.createServer({ key, cert }, app);
  } else {
    console.log('🌐 Starting HTTP server...');
    server = http.createServer(app);
  }
} catch (err) {
  console.log('❌ Error creating server:', err.message);
  process.exit(1);
}

// Initialize Socket.IO
initializeSocket(server);

// Start listening
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} [${NODE_ENV}]`);
});

// --- Graceful shutdown ---
const shutdown = async (signal) => {
  console.log(`\n⚠️  ${signal} received. Shutting down gracefully...`);
  
  try {
    server.close(() => {
      console.log('✅ HTTP server closed');
    });

    await mongoose.connection.close(false);
    console.log('✅ Database connection closed');

    setTimeout(() => {
      console.log('👋 Goodbye!');
      process.exit(0);
    }, 1000);
  } catch (err) {
    console.log('❌ Error during shutdown:', err.message);
    process.exit(1);
  }
};

// Handle signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.log('❌ UNCAUGHT EXCEPTION:', err.message);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.log('❌ UNHANDLED REJECTION:', err.message);
  process.exit(1);
});

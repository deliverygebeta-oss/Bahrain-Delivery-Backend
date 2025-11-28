// server.js
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import http from 'http';
import app from './app.js';
import { initializeSocket } from './socketServer.js'; // We'll create this

dotenv.config({ path: './.env' });

const DB = process.env.DATABASE;
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!DB) {
  console.error('DATABASE environment variable is not defined!');
  process.exit(1);
}

if (!JWT_SECRET) {
  console.error('JWT_SECRET environment variable is not defined!');
  process.exit(1);
}

mongoose
  .connect(DB)
  .then(() => console.log('DB connection successful!'))
  .catch((err) => {
    console.error('DB connection error:', err.message);
    process.exit(1);
  });

// Create HTTP Server
const httpServer = http.createServer(app);

// Initialize Socket.IO (attached to httpServer)
initializeSocket(httpServer);

httpServer.listen(PORT, () => {
  console.log(`App running on port ${PORT}...`);
});

// Graceful shutdown
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION! Shutting down...');
  console.error('Error:', err);
  console.error(err.name, err.message);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION! Shutting down...');
  console.error(err.name, err.message);
  httpServer.close(() => process.exit(1));
});
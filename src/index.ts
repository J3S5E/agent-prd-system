import { createServer } from 'http';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

import cors from 'cors';
import { WebSocketServer } from 'ws';
import express from 'express';
import dotenv from 'dotenv';

import apiRoutes from './api/routes.js';
import { closeDb } from './db/index.js';
import { broadcastShutdown, subscribe, unsubscribe } from './engine/events.js';
import { waitForInFlight } from './api/inflight.js';

import type { WebSocket as WSWebSocket } from 'ws';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isProduction = process.env.NODE_ENV === 'production';

// Resolve dashboard path: use dist/dashboard in production, src/dashboard in development
const isDist = __dirname.endsWith('dist');
const dashboardPath = isDist
  ? path.join(__dirname, 'dashboard/public')
  : path.join(__dirname, '..', 'src/dashboard/public');

// Verify dashboard exists (built)
if (!existsSync(dashboardPath)) {
  console.warn(`Dashboard not found at ${dashboardPath}. Run 'npm run build:dashboard' first.`);
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = parseInt(process.env.PRD_SERVER_PORT || '42069', 10);
const ALLOWED_ORIGIN = process.env.PRD_ALLOWED_ORIGIN || (isProduction ? 'http://localhost:42069' : '*');

// Middleware
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// API request logging
app.use('/api/v1', async (req, res, next) => {
  const start = Date.now();
  const requestBody = req.method !== 'GET' ? JSON.stringify(req.body) : undefined;
  
  res.on('finish', async () => {
    try {
      const { db } = await import('./db/index.js');
      const { apiLogs } = await import('./db/schema.js');
      await db.insert(apiLogs).values({
        id: crypto.randomUUID(),
        endpoint: req.path,
        method: req.method,
        requestBody,
        responseStatus: res.statusCode,
        ticketId: req.path.match(/\/tickets\/([^/]+)/)?.[1] || null,
        createdAt: start,
      });
    } catch (err) {
      console.error('Log write failed:', err);
    }
  });
  
  next();
});

// API routes
app.use('/api/v1', apiRoutes);

// Serve dashboard static files
app.use(express.static(dashboardPath));

// SPA fallback for dashboard routes
app.get(['/', '/repo/:repo', '/ticket/:id', '/flagged'], (req, res) => {
  res.sendFile(path.join(dashboardPath, 'index.html'));
});

// WebSocket handling
wss.on('connection', (ws: WSWebSocket, _req) => {
  console.log('New WebSocket connection');
  
  let subscribedRepo = '*';
  
  ws.on('message', (data) => {
    try {
      const raw: unknown = JSON.parse(data.toString());
      
      // Type guard for WebSocket message
      function isWSMessage(val: unknown): val is { type: string; repo?: string } {
        return typeof val === 'object' && val !== null && 'type' in val && typeof (val as Record<string, unknown>).type === 'string';
      }
      
      if (!isWSMessage(raw)) return;
      
      if (raw.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      } else if (raw.type === 'subscribe') {
        // Unsubscribe from previous repo
        if (subscribedRepo !== '*') {
          unsubscribe(ws, subscribedRepo);
        }
        subscribedRepo = raw.repo ?? '*';
        subscribe(ws, subscribedRepo);
      }
    } catch (err) {
      console.error('WS message error:', err);
    }
  });
  
  ws.on('close', () => {
    unsubscribe(ws, subscribedRepo);
    console.log('WebSocket disconnected');
  });
  
  // Subscribe to all by default
  subscribe(ws, '*');
});

// Graceful shutdown
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  
  console.log(`${signal} received, starting graceful shutdown...`);
  
  // Stop accepting new connections
  server.close(() => {
    console.log('HTTP server closed');
  });
  
  // Wait for in-flight validation requests (max 30s)
  console.log('Waiting for in-flight validation requests...');
  await waitForInFlight(30000);
  
  // Notify WS clients
  broadcastShutdown();
  
  // Close all WS connections
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.close(1001, 'Server shutting down');
    }
  }
  wss.close();
  
  // Close DB
  closeDb();
  
  console.log('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start server
server.listen(PORT, () => {
  console.log(`PRD Webserver running on http://localhost:${PORT}`);
  console.log(`Dashboard available at http://localhost:${PORT}`);
  console.log(`WebSocket at ws://localhost:${PORT}/ws`);
});
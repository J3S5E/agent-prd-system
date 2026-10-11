import { Request, Response, Router } from 'express';
import { sql, count, eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { tickets } from '../db/schema.js';

const router = Router();
const startTime = Date.now();

router.get('/health', (req: Request, res: Response) => {
  try {
    db.run(sql`SELECT 1`);
    
    res.json({
      status: 'ok',
      db: 'connected',
      uptime: Date.now() - startTime,
      timestamp: Date.now(),
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      db: 'disconnected',
      uptime: Date.now() - startTime,
      timestamp: Date.now(),
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

router.get('/ready', async (req: Request, res: Response) => {
  try {
    db.run(sql`SELECT 1`);
    
    const result = await db
      .select({ count: count() })
      .from(tickets)
      .where(eq(tickets.status, 'NEEDS_VALIDATION'));
    
    const pending = Number(result[0]?.count || 0);
    
    res.json({
      ready: true,
      validationQueue: { pending, capacity: 100 },
      timestamp: Date.now(),
    });
  } catch (err) {
    res.status(503).json({
      ready: false,
      validationQueue: { pending: 0, capacity: 0 },
      timestamp: Date.now(),
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

export default router;
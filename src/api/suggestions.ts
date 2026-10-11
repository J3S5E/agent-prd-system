import { Request, Response, Router } from 'express';
import { eq, desc, count } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db/index.js';
import { suggestions, tickets } from '../db/schema.js';
import { broadcast } from '../engine/events.js';


const router = Router();

const CreateSuggestionSchema = z.object({
  source: z.string().min(1),
  description: z.string().min(1),
});

router.get('/:id/suggestions', async (req: Request, res: Response) => {
  const query = req.query;
  
  function isRecord(val: unknown): val is Record<string, unknown> {
    return typeof val === 'object' && val !== null && !Array.isArray(val);
  }
  
  let limit: number = 50;
  let offset: number = 0;
  
  if (isRecord(query)) {
    if (Object.prototype.hasOwnProperty.call(query, 'limit')) {
      const val = query['limit'];
      if (Array.isArray(val)) {
        const first = val[0];
        limit = typeof first === 'string' ? parseInt(first, 10) || 50 : 50;
      } else {
        limit = typeof val === 'string' ? parseInt(val, 10) || 50 : 50;
      }
    }
    if (Object.prototype.hasOwnProperty.call(query, 'offset')) {
      const val = query['offset'];
      if (Array.isArray(val)) {
        const first = val[0];
        offset = typeof first === 'string' ? parseInt(first, 10) || 0 : 0;
      } else {
        offset = typeof val === 'string' ? parseInt(val, 10) || 0 : 0;
      }
    }
  }
  
  limit = Math.min(limit, 200);
  
  const totalResult = await db
    .select({ count: count() })
    .from(suggestions)
    .where(eq(suggestions.ticketId, req.params.id));
  const total = Number(totalResult[0]?.count || 0);
  
  const results = await db
    .select()
    .from(suggestions)
    .where(eq(suggestions.ticketId, req.params.id))
    .orderBy(desc(suggestions.createdAt))
    .limit(limit)
    .offset(offset);
  
  res.setHeader('X-Total-Count', total.toString());
  res.json(results);
});

router.post('/:id/suggestions', async (req: Request, res: Response) => {
  const ticket = await db.select().from(tickets).where(eq(tickets.id, req.params.id)).limit(1);
  if (ticket.length === 0) {
    return res.status(404).json({ error: 'Ticket not found' });
  }
  
  const parse = CreateSuggestionSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
  }
  
  const id = crypto.randomUUID();
  const now = Date.now();
  
  await db.insert(suggestions).values({
    id,
    ticketId: req.params.id,
    source: parse.data.source,
    description: parse.data.description,
    resolved: false,
    createdAt: now,
  });
  
  const created = await db.select().from(suggestions).where(eq(suggestions.id, id)).limit(1);
  broadcast({ type: 'suggestion:added', suggestion: created[0] });
  
  res.status(201).json(created[0]);
});

router.patch('/suggestions/:id/resolve', async (req: Request, res: Response) => {
  const existing = await db.select().from(suggestions).where(eq(suggestions.id, req.params.id)).limit(1);
  if (existing.length === 0) {
    return res.status(404).json({ error: 'Suggestion not found' });
  }
  
  await db.update(suggestions)
    .set({ resolved: true, resolvedAt: Date.now() })
    .where(eq(suggestions.id, req.params.id));
  
  const updated = await db.select().from(suggestions).where(eq(suggestions.id, req.params.id)).limit(1);
  res.json(updated[0]);
});

router.delete('/suggestions/:id', async (req: Request, res: Response) => {
  const existing = await db.select().from(suggestions).where(eq(suggestions.id, req.params.id)).limit(1);
  if (existing.length === 0) {
    return res.status(404).json({ error: 'Suggestion not found' });
  }
  
  await db.delete(suggestions).where(eq(suggestions.id, req.params.id));
  res.status(204).send();
});

export default router;
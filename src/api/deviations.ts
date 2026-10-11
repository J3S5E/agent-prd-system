import { Request, Response, Router } from 'express';
import { eq, desc, count } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db/index.js';
import { deviations, tickets } from '../db/schema.js';
import { broadcast } from '../engine/events.js';


const router = Router();

const CreateDeviationSchema = z.object({
  action: z.enum(['omitted', 'replaced']),
  description: z.string().min(1),
});

const ApproveDeviationSchema = z.object({
  approved: z.boolean(),
});

router.get('/:id/deviations', async (req: Request, res: Response) => {
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
    .from(deviations)
    .where(eq(deviations.ticketId, req.params.id));
  const total = Number(totalResult[0]?.count || 0);
  
  const results = await db
    .select()
    .from(deviations)
    .where(eq(deviations.ticketId, req.params.id))
    .orderBy(desc(deviations.createdAt))
    .limit(limit)
    .offset(offset);
  
  res.setHeader('X-Total-Count', total.toString());
  res.json(results);
});

router.post('/:id/deviations', async (req: Request, res: Response) => {
  const ticket = await db.select().from(tickets).where(eq(tickets.id, req.params.id)).limit(1);
  if (ticket.length === 0) {
    return res.status(404).json({ error: 'Ticket not found' });
  }
  
  const parse = CreateDeviationSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
  }
  
  const id = crypto.randomUUID();
  const now = Date.now();
  
  await db.insert(deviations).values({
    id,
    ticketId: req.params.id,
    action: parse.data.action,
    description: parse.data.description,
    reviewApproved: false,
    qaApproved: false,
    createdAt: now,
  });
  
  const created = await db.select().from(deviations).where(eq(deviations.id, id)).limit(1);
  broadcast({ type: 'deviation:added', deviation: created[0] });
  
  res.status(201).json(created[0]);
});

router.patch('/deviations/:id/review', async (req: Request, res: Response) => {
  const parse = ApproveDeviationSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
  }
  
  const existing = await db.select().from(deviations).where(eq(deviations.id, req.params.id)).limit(1);
  if (existing.length === 0) {
    return res.status(404).json({ error: 'Deviation not found' });
  }
  
  await db.update(deviations)
    .set({ reviewApproved: parse.data.approved })
    .where(eq(deviations.id, req.params.id));
  
  const updated = await db.select().from(deviations).where(eq(deviations.id, req.params.id)).limit(1);
  res.json(updated[0]);
});

router.patch('/deviations/:id/qa', async (req: Request, res: Response) => {
  const parse = ApproveDeviationSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
  }
  
  const existing = await db.select().from(deviations).where(eq(deviations.id, req.params.id)).limit(1);
  if (existing.length === 0) {
    return res.status(404).json({ error: 'Deviation not found' });
  }
  
  await db.update(deviations)
    .set({ qaApproved: parse.data.approved })
    .where(eq(deviations.id, req.params.id));
  
  const updated = await db.select().from(deviations).where(eq(deviations.id, req.params.id)).limit(1);
  res.json(updated[0]);
});

router.delete('/deviations/:id', async (req: Request, res: Response) => {
  const existing = await db.select().from(deviations).where(eq(deviations.id, req.params.id)).limit(1);
  if (existing.length === 0) {
    return res.status(404).json({ error: 'Deviation not found' });
  }
  
  await db.delete(deviations).where(eq(deviations.id, req.params.id));
  res.status(204).send();
});

export default router;
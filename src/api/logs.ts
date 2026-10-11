import { Request, Response, Router } from 'express';
import { eq, and, or, desc, asc, sql, count, inArray, isNull, like } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db/index.js';
import { apiLogs, tickets } from '../db/schema.js';

const router = Router();

const ListLogsQuerySchema = z.object({
  ticketId: z.string().optional(),
  endpoint: z.string().optional(),
  method: z.string().optional(),
  eventType: z.string().optional(),
  statusMin: z.coerce.number().int().optional(),
  statusMax: z.coerce.number().int().optional(),
  createdAfter: z.coerce.number().optional(),
  createdBefore: z.coerce.number().optional(),
  sort: z.string().optional().default('createdAt:desc'),
  limit: z.coerce.number().int().positive().max(1000).optional().default(50),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});

router.get('/', async (req: Request, res: Response) => {
  const parse = ListLogsQuerySchema.safeParse(req.query);
  
  if (!parse.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
  }
  
  const { ticketId, endpoint, method, eventType, statusMin, statusMax, createdAfter, createdBefore, sort, limit, offset } = parse.data;
  
  const conditions = [];
  
  if (ticketId) conditions.push(eq(apiLogs.ticketId, ticketId));
  if (endpoint) conditions.push(like(apiLogs.endpoint, `%${endpoint}%`));
  if (method) conditions.push(eq(apiLogs.method, method.toUpperCase()));
  if (eventType) conditions.push(eq(apiLogs.eventType, eventType));
  if (statusMin !== undefined) conditions.push(sql`${apiLogs.responseStatus} >= ${statusMin}`);
  if (statusMax !== undefined) conditions.push(sql`${apiLogs.responseStatus} <= ${statusMax}`);
  if (createdAfter) conditions.push(sql`${apiLogs.createdAt} >= ${createdAfter}`);
  if (createdBefore) conditions.push(sql`${apiLogs.createdAt} <= ${createdBefore}`);
  
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  
  // Parse sort
  let orderBy = desc(apiLogs.createdAt);
  if (sort) {
    const [field, direction] = sort.split(':');
    const col = field === 'createdAt' ? apiLogs.createdAt : apiLogs.responseStatus;
    orderBy = direction === 'asc' ? asc(col) : desc(col);
  }
  
  // Get total count
  const totalResult = await db.select({ count: count() }).from(apiLogs).where(whereClause);
  const total = Number(totalResult[0]?.count || 0);
  
  // Get paginated results
  const results = await db.select().from(apiLogs).where(whereClause).orderBy(orderBy).limit(limit).offset(offset);
  
  res.setHeader('X-Total-Count', total.toString());
  res.json(results);
});

router.get('/event-types', async (_req: Request, res: Response) => {
  const result = await db.selectDistinct({ eventType: apiLogs.eventType }).from(apiLogs).where(sql`${apiLogs.eventType} IS NOT NULL`);
  res.json(result.map(r => r.eventType).filter(Boolean));
});

router.get('/endpoints', async (_req: Request, res: Response) => {
  const result = await db.selectDistinct({ endpoint: apiLogs.endpoint }).from(apiLogs).where(sql`${apiLogs.endpoint} IS NOT NULL`);
  res.json(result.map(r => r.endpoint).filter(Boolean));
});

export default router;
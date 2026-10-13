import { Request, Response, Router } from 'express';
import { eq, and, lt, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'crypto';

import { db } from '../db/index.js';
import { ralphInstances, ticketLocks, tickets } from '../db/schema.js';
import { broadcast } from '../engine/events.js';
import { generateRalphName } from '../constants/ralph-names.js';

const router = Router();

const RegisterRalphSchema = z.object({
  repo: z.string().min(1),
  preferredName: z.string().optional(),
});

router.post('/register', async (req: Request, res: Response) => {
  const parse = RegisterRalphSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
  }

  const { repo, preferredName } = parse.data;
  const name = generateRalphName(repo, preferredName);
  const id = randomUUID();
  const now = Date.now();

  try {
    // Check if name already exists
    const existing = await db.select().from(ralphInstances).where(eq(ralphInstances.name, name)).limit(1);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Name already taken', name });
    }

    await db.insert(ralphInstances).values({
      id,
      name,
      repo,
      status: 'idle',
      lastHeartbeat: now,
      createdAt: now,
    });

    const created = await db.select().from(ralphInstances).where(eq(ralphInstances.id, id)).limit(1);
    broadcast({ type: 'ralph:registered', instanceId: id, name, repo, status: 'idle' });
    res.status(201).json(created[0]);
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Name already taken', name });
    }
    res.status(500).json({ error: 'Failed to register ralph instance', details: err instanceof Error ? err.message : 'Unknown error' });
  }
});

const HeartbeatSchema = z.object({
  instanceId: z.string().uuid(),
});

router.post('/heartbeat', async (req: Request, res: Response) => {
  const parse = HeartbeatSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
  }

  const { instanceId } = parse.data;
  const now = Date.now();

  await db.update(ralphInstances).set({ lastHeartbeat: now }).where(eq(ralphInstances.id, instanceId));

  res.json({ ok: true });
});

const AcquireLockSchema = z.object({
  instanceId: z.string().uuid(),
  ticketId: z.string().uuid(),
  lockType: z.enum(['validation', 'processing']),
  ttlMs: z.number().int().positive().optional().default(1860000), // 31 min default
});

router.post('/lock/acquire', async (req: Request, res: Response) => {
  const parse = AcquireLockSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
  }

  const { instanceId, ticketId, lockType, ttlMs } = parse.data;
  const now = Date.now();
  const expiresAt = now + ttlMs;

  // Verify instance exists and is alive
  const instance = await db.select().from(ralphInstances).where(eq(ralphInstances.id, instanceId)).limit(1);
  if (instance.length === 0) {
    return res.status(404).json({ error: 'Ralph instance not found' });
  }
  if (instance[0].status === 'offline') {
    return res.status(400).json({ error: 'Ralph instance is offline' });
  }

  // Verify ticket exists
  const ticket = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (ticket.length === 0) {
    return res.status(404).json({ error: 'Ticket not found' });
  }

  // Check for existing lock
  const existingLock = await db.select().from(ticketLocks).where(eq(ticketLocks.ticketId, ticketId)).limit(1);
  if (existingLock.length > 0) {
    const lock = existingLock[0];
    if (lock.expiresAt > now) {
      // Lock is still valid
      if (lock.ralphInstanceId === instanceId) {
        // Same instance, extend lock
        await db.update(ticketLocks).set({ expiresAt }).where(eq(ticketLocks.ticketId, ticketId));
        return res.json({ acquired: true, lock: { ...lock, expiresAt } });
      }
      return res.status(409).json({ error: 'Ticket locked by another ralph', lockedBy: lock.ralphInstanceId, expiresAt: lock.expiresAt });
    }
    // Lock expired, remove it
    await db.delete(ticketLocks).where(eq(ticketLocks.ticketId, ticketId));
  }

  // Acquire new lock
  await db.insert(ticketLocks).values({
    ticketId,
    ralphInstanceId: instanceId,
    lockedAt: now,
    expiresAt,
    lockType,
  });

  // Update instance status
  await db.update(ralphInstances).set({ status: 'busy', currentTicketId: ticketId }).where(eq(ralphInstances.id, instanceId));

  broadcast({ type: 'ticket:lock_acquired', ticketId, instanceId, lockType });

  res.json({ acquired: true, lock: { ticketId, ralphInstanceId: instanceId, lockedAt: now, expiresAt, lockType } });
});

const ReleaseLockSchema = z.object({
  instanceId: z.string().uuid(),
  ticketId: z.string().uuid(),
});

router.post('/lock/release', async (req: Request, res: Response) => {
  const parse = ReleaseLockSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
  }

  const { instanceId, ticketId } = parse.data;

  const lock = await db.select().from(ticketLocks).where(eq(ticketLocks.ticketId, ticketId)).limit(1);
  if (lock.length === 0) {
    return res.status(404).json({ error: 'Lock not found' });
  }

  if (lock[0].ralphInstanceId !== instanceId) {
    return res.status(403).json({ error: 'Lock owned by another ralph instance' });
  }

  await db.delete(ticketLocks).where(eq(ticketLocks.ticketId, ticketId));

  // Check if instance has other locks
  const otherLocks = await db.select().from(ticketLocks).where(eq(ticketLocks.ralphInstanceId, instanceId)).limit(1);
  if (otherLocks.length === 0) {
    await db.update(ralphInstances).set({ status: 'idle', currentTicketId: null }).where(eq(ralphInstances.id, instanceId));
  }

  broadcast({ type: 'ticket:lock_released', ticketId, instanceId });

  res.json({ released: true });
});

router.get('/instances', async (req: Request, res: Response) => {
  const repo = req.query.repo as string | undefined;
  const instances = repo
    ? await db.select().from(ralphInstances).where(eq(ralphInstances.repo, repo))
    : await db.select().from(ralphInstances);
  res.json(instances);
});

router.get('/locks', async (req: Request, res: Response) => {
  const now = Date.now();
  const locks = await db.select({
    ticketId: ticketLocks.ticketId,
    instanceId: ticketLocks.ralphInstanceId,
    lockType: ticketLocks.lockType,
    expiresAt: ticketLocks.expiresAt,
    instanceName: ralphInstances.name,
  })
    .from(ticketLocks)
    .innerJoin(ralphInstances, eq(ticketLocks.ralphInstanceId, ralphInstances.id))
    .where(gt(ticketLocks.expiresAt, now));
  res.json(locks);
});

router.delete('/instances/:id', async (req: Request, res: Response) => {
  const instanceId = req.params.id;

  // Release any locks held by this instance
  await db.delete(ticketLocks).where(eq(ticketLocks.ralphInstanceId, instanceId));

  await db.delete(ralphInstances).where(eq(ralphInstances.id, instanceId));

  res.status(204).send();
});

// Cleanup stale locks and offline instances (run periodically)
router.post('/cleanup', async (req: Request, res: Response) => {
  const now = Date.now();

  // Delete expired locks
  const expiredLocks = await db.select().from(ticketLocks).where(lt(ticketLocks.expiresAt, now));
  for (const lock of expiredLocks) {
    await db.delete(ticketLocks).where(eq(ticketLocks.ticketId, lock.ticketId));
    broadcast({ type: 'ticket:lock_expired', ticketId: lock.ticketId, instanceId: lock.ralphInstanceId });
  }

  // Mark instances as offline if no heartbeat for 60s
  const staleThreshold = now - 60000;
  const staleInstances = await db.select().from(ralphInstances).where(and(lt(ralphInstances.lastHeartbeat, staleThreshold), eq(ralphInstances.status, 'busy')));
  for (const instance of staleInstances) {
    // Release their locks
    const locks = await db.select().from(ticketLocks).where(eq(ticketLocks.ralphInstanceId, instance.id));
    for (const lock of locks) {
      await db.delete(ticketLocks).where(eq(ticketLocks.ticketId, lock.ticketId));
      broadcast({ type: 'ticket:lock_expired', ticketId: lock.ticketId, instanceId: lock.ralphInstanceId });
    }
    await db.update(ralphInstances).set({ status: 'offline', currentTicketId: null }).where(eq(ralphInstances.id, instance.id));
    broadcast({ type: 'ralph:offline', instanceId: instance.id });
  }

  res.json({ cleanedLocks: expiredLocks.length, offlineInstances: staleInstances.length });
});

export default router;
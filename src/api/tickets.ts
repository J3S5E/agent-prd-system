import { Request, Response, Router } from 'express';
import { eq, and, or, desc, asc, sql, count, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db/index.js';
import { tickets, repos, evidence, suggestions, deviations, validationRuns } from '../db/schema.js';
import { CreateTicketSchema, UpdateTicketSchema, UpdateTicketStatusSchema, UnblockTicketSchema, CreateSubtaskSchema, TicketStatus, TicketStatusEnum } from '../types/ticket.js';
import { validateTransition, getUnblockTarget, isFlaggedStatus, getFlaggedReason, getNextStatus } from '../engine/fsm.js';
import { broadcast } from '../engine/events.js';
import { checkImplementationCircuitBreaker, checkPlanCircuitBreaker, getCircuitBreakerState, incrementPlanIteration, resetImplementationRetry, resetValidationAttempts } from '../engine/circuits.js';
import { getSubtasks, areAllSubtasksDone } from '../engine/subtasks.js';


const router = Router();

function parseTicketStatus(status: string): TicketStatus {
  const parsed = TicketStatusEnum.safeParse(status);
  if (!parsed.success) {
    throw new Error(`Invalid ticket status: ${status}`);
  }
  return parsed.data;
}

interface TicketWithSubtasks {
  id: string;
  repo: string;
  name: string;
  description: string | null;
  status: string;
  targetBranch: string | null;
  featureBranch: string | null;
  worktreeDir: string | null;
  parentTicketId: string | null;
  plan: string | null;
  planIssues: string | null;
  blockingIssues: string | null;
  reviewComments: string | null;
  securityNotes: string | null;
  qaNotes: string | null;
  createdAt: number;
  updatedAt: number;
  subtasks?: unknown[];
}

const ListTicketsQuerySchema = z.object({
  repo: z.string().optional(),
  status: z.string().optional(),
  flagged: z.coerce.boolean().optional(),
  parentOnly: z.coerce.boolean().optional(),
  parentId: z.string().optional(),
  include: z.string().optional(),
  assignee: z.string().optional(),
  branch: z.string().optional(),
  createdAfter: z.coerce.number().optional(),
  createdBefore: z.coerce.number().optional(),
  sort: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional().default(50),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});

router.get('/', async (req: Request, res: Response) => {
  const parse = ListTicketsQuerySchema.safeParse(req.query);
  
  if (!parse.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
  }
  
  const { repo, status, flagged, parentOnly, parentId, include, assignee, branch, createdAfter, createdBefore, sort, limit, offset } = parse.data;
  
  const conditions = [];
  
  if (repo) conditions.push(eq(tickets.repo, repo));
  if (status) {
    const statusList = status.split(',').map(s => s.trim());
    conditions.push(inArray(tickets.status, statusList));
  }
  if (parentOnly) conditions.push(isNull(tickets.parentTicketId));
  if (parentId) conditions.push(eq(tickets.parentTicketId, parentId));
  if (assignee) conditions.push(eq(tickets.featureBranch, assignee)); // using featureBranch as assignee proxy
  if (branch) conditions.push(eq(tickets.featureBranch, branch));
  if (createdAfter) conditions.push(sql`${tickets.createdAt} >= ${createdAfter}`);
  if (createdBefore) conditions.push(sql`${tickets.createdAt} <= ${createdBefore}`);
  if (flagged) conditions.push(inArray(tickets.status, ['NEEDS_HUMAN_INTERVENTION', 'NEEDS_HUMAN_CLARIFICATION', 'NEEDS_HUMAN_PLAN_REVIEW']));
  
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  
  // Parse sort
  let orderBy = desc(tickets.createdAt);
  if (sort) {
    const [field, direction] = sort.split(':');
    const col = field === 'createdAt' ? tickets.createdAt : tickets.updatedAt;
    orderBy = direction === 'asc' ? asc(col) : desc(col);
  }
  
  // Get total count
  const totalResult = await db.select({ count: count() }).from(tickets).where(whereClause);
  const total = Number(totalResult[0]?.count || 0);
  
  // Get paginated results
  const results = await db.select().from(tickets).where(whereClause).orderBy(orderBy).limit(limit).offset(offset);
  
  // Include relations if requested
  const ticketsWithRelations: TicketWithSubtasks[] = results.map(t => ({ ...t }));
  if (include === 'subtasks') {
    for (const ticket of ticketsWithRelations) {
      if (!ticket.parentTicketId) {
        const subtasks = await getSubtasks(ticket.id);
        ticket.subtasks = subtasks;
      }
    }
  }
  
  res.setHeader('X-Total-Count', total.toString());
  res.json(ticketsWithRelations);
});

router.get('/:id', async (req: Request, res: Response) => {
  const ticket = await db.select().from(tickets).where(eq(tickets.id, req.params.id)).limit(1);
  
  if (ticket.length === 0) {
    return res.status(404).json({ error: 'Ticket not found' });
  }
  
  const ticketData = ticket[0];
  
  // Get relations
  const [ev, sug, dev, val, subtasks] = await Promise.all([
    db.select().from(evidence).where(or(eq(evidence.ticketId, req.params.id), eq(evidence.subtaskId, req.params.id))),
    db.select().from(suggestions).where(eq(suggestions.ticketId, req.params.id)),
    db.select().from(deviations).where(eq(deviations.ticketId, req.params.id)),
    db.select().from(validationRuns).where(eq(validationRuns.ticketId, req.params.id)),
    getSubtasks(req.params.id),
  ]);
  
  res.json({ ...ticketData, evidence: ev, suggestions: sug, deviations: dev, validationRuns: val, subtasks });
});

router.post('/', async (req: Request, res: Response) => {
  const parse = CreateTicketSchema.safeParse(req.body);
  
  if (!parse.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
  }
  
  const { repo, name, description, targetBranch, jiraTicket, priority } = parse.data;
  
  const existingRepo = await db.select().from(repos).where(eq(repos.name, repo)).limit(1);
  if (existingRepo.length === 0) {
    const defaultWorktreeBase = process.env.PRD_WORKTREE_BASE || '.';
    await db.insert(repos).values({
      name: repo,
      worktreeBase: defaultWorktreeBase,
      createdAt: Date.now(),
    });
  }
  
  const id = crypto.randomUUID();
  const now = Date.now();
  
  await db.insert(tickets).values({
    id,
    repo,
    name,
    description,
    status: 'NEEDS_REFINEMENT',
    targetBranch,
    jiraTicket,
    priority: priority || 'P2',
    createdAt: now,
    updatedAt: now,
  });
  
  const created = await db.select().from(tickets).where(eq(tickets.id, id)).limit(1);
  broadcast({ type: 'ticket:created', ticket: created[0] });
  
  res.status(201).json(created[0]);
});

router.patch('/:id', async (req: Request, res: Response) => {
  const parse = UpdateTicketSchema.safeParse(req.body);
  
  if (!parse.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
  }
  
  const existing = await db.select().from(tickets).where(eq(tickets.id, req.params.id)).limit(1);
  if (existing.length === 0) {
    return res.status(404).json({ error: 'Ticket not found' });
  }
  
  const updates = { ...parse.data, updatedAt: Date.now() };
  await db.update(tickets).set(updates).where(eq(tickets.id, req.params.id));
  
  const updated = await db.select().from(tickets).where(eq(tickets.id, req.params.id)).limit(1);
  res.json(updated[0]);
});

router.patch('/:id/status', async (req: Request, res: Response) => {
  const parse = UpdateTicketStatusSchema.safeParse(req.body);
  
  if (!parse.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
  }
  
  const { newStatus } = parse.data;
  
  const existing = await db.select().from(tickets).where(eq(tickets.id, req.params.id)).limit(1);
  if (existing.length === 0) {
    return res.status(404).json({ error: 'Ticket not found' });
  }
  
  const currentStatus = parseTicketStatus(existing[0].status);
  const transition = validateTransition(currentStatus, newStatus);
  
  if (!transition.success) {
    return res.status(400).json({ error: transition.error });
  }
  
  // Check circuit breakers on certain transitions
  let targetStatus = newStatus;
  
  // Plan circuit breaker: increment iteration when sending back for updates
  if (currentStatus === 'READY_PLAN_REVIEW' && newStatus === 'NEEDS_PLAN_UPDATING') {
    await incrementPlanIteration(req.params.id);
    const state = await getCircuitBreakerState(req.params.id);
    if (state) {
      const planCheck = checkPlanCircuitBreaker(state);
      if (planCheck.tripped) {
        targetStatus = planCheck.targetStatus!;
      }
    }
  }
  
  // Implementation circuit breaker: check when moving to validation
  if (newStatus === 'NEEDS_VALIDATION') {
    const state = await getCircuitBreakerState(req.params.id);
    if (state) {
      const implCheck = checkImplementationCircuitBreaker(state);
      if (implCheck.tripped) {
        targetStatus = implCheck.targetStatus!;
      }
    }
  }
  
  await db.update(tickets).set({ status: targetStatus, updatedAt: Date.now() }).where(eq(tickets.id, req.params.id));
  
  broadcast({ type: 'ticket:status_changed', ticketId: req.params.id, from: currentStatus, to: targetStatus });
  
  if (isFlaggedStatus(targetStatus)) {
    broadcast({ type: 'ticket:flagged', ticketId: req.params.id, reason: getFlaggedReason(targetStatus) });
  }
  
  // Check if parent needs to advance
  if (existing[0].parentTicketId) {
    const allDone = await areAllSubtasksDone(existing[0].parentTicketId);
    if (allDone) {
      const parent = await db.select().from(tickets).where(eq(tickets.id, existing[0].parentTicketId)).limit(1);
      if (parent.length > 0) {
        const parentStatus = parseTicketStatus(parent[0].status);
        const allowed = validateTransition(parentStatus, getNextStatus(parentStatus)!);
        if (allowed.success) {
          await db.update(tickets).set({ status: allowed.newStatus, updatedAt: Date.now() }).where(eq(tickets.id, existing[0].parentTicketId));
          broadcast({ type: 'ticket:status_changed', ticketId: existing[0].parentTicketId, from: parentStatus, to: allowed.newStatus });
        }
      }
    }
  }
  
  const updated = await db.select().from(tickets).where(eq(tickets.id, req.params.id)).limit(1);
  res.json({ ...updated[0], previousStatus: currentStatus });
});

router.post('/:id/unblock', async (req: Request, res: Response) => {
  const parse = UnblockTicketSchema.safeParse(req.body);
  
  if (!parse.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
  }
  
  const { direction } = parse.data;
  
  const existing = await db.select().from(tickets).where(eq(tickets.id, req.params.id)).limit(1);
  if (existing.length === 0) {
    return res.status(404).json({ error: 'Ticket not found' });
  }
  
  const currentStatus = parseTicketStatus(existing[0].status);
  
  if (!isFlaggedStatus(currentStatus)) {
    return res.status(400).json({ error: 'Ticket is not in a flagged state' });
  }
  
  // Check if parent has subtasks (for NEEDS_HUMAN_PLAN_REVIEW forward)
  let hasSubtasks = false;
  if (currentStatus === 'NEEDS_HUMAN_PLAN_REVIEW' && direction === 'forward') {
    const subtasks = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.parentTicketId, req.params.id)).limit(1);
    hasSubtasks = subtasks.length > 0;
  }
  
  const newStatus = getUnblockTarget(currentStatus, direction, hasSubtasks);
  
  // Reset appropriate counters based on direction
  if (direction === 'forward') {
    if (currentStatus === 'NEEDS_HUMAN_INTERVENTION') {
      await resetValidationAttempts(req.params.id);
    } else if (currentStatus === 'NEEDS_HUMAN_CLARIFICATION') {
      await resetImplementationRetry(req.params.id);
    }
  }
  
  await db.update(tickets).set({ status: newStatus, updatedAt: Date.now() }).where(eq(tickets.id, req.params.id));
  
  broadcast({ type: 'ticket:status_changed', ticketId: req.params.id, from: currentStatus, to: newStatus });
  
  const _updated = await db.select().from(tickets).where(eq(tickets.id, req.params.id)).limit(1);
  res.json({ ticketId: req.params.id, previousStatus: currentStatus, newStatus, direction });
});

router.post('/:id/subtasks', async (req: Request, res: Response) => {
  const parse = CreateSubtaskSchema.safeParse(req.body);
  
  if (!parse.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
  }
  
  const parent = await db.select().from(tickets).where(eq(tickets.id, req.params.id)).limit(1);
  if (parent.length === 0) {
    return res.status(404).json({ error: 'Parent ticket not found' });
  }
  
  if (parent[0].parentTicketId) {
    return res.status(400).json({ error: 'Cannot create subtask on a subtask' });
  }
  
  const { name, description } = parse.data;
  const id = crypto.randomUUID();
  const now = Date.now();
  
  await db.insert(tickets).values({
    id,
    repo: parent[0].repo,
    name,
    description,
    status: 'NEEDS_REFINEMENT',
    targetBranch: parent[0].featureBranch || parent[0].targetBranch,
    parentTicketId: req.params.id,
    createdAt: now,
    updatedAt: now,
  });
  
  const created = await db.select().from(tickets).where(eq(tickets.id, id)).limit(1);
  broadcast({ type: 'subtask:created', subtask: created[0], parentId: req.params.id });
  
  res.status(201).json(created[0]);
});

router.delete('/:id', async (req: Request, res: Response) => {
  const existing = await db.select().from(tickets).where(eq(tickets.id, req.params.id)).limit(1);
  if (existing.length === 0) {
    return res.status(404).json({ error: 'Ticket not found' });
  }

  // Cascading delete in transaction - order respects FKs
  await db.transaction(async (tx) => {
    // 1. Delete subtasks (child tickets where parentTicketId = ticket.id)
    const subtasks = await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.parentTicketId, req.params.id));
    for (const subtask of subtasks) {
      // Recursively delete subtask's related data
      await tx.delete(evidence).where(or(eq(evidence.ticketId, subtask.id), eq(evidence.subtaskId, subtask.id)));
      await tx.delete(suggestions).where(eq(suggestions.ticketId, subtask.id));
      await tx.delete(deviations).where(eq(deviations.ticketId, subtask.id));
      await tx.delete(validationRuns).where(eq(validationRuns.ticketId, subtask.id));
      await tx.delete(tickets).where(eq(tickets.id, subtask.id));
    }

    // 2. Delete evidence (where ticketId = ticket.id OR subtaskId = ticket.id)
    await tx.delete(evidence).where(or(eq(evidence.ticketId, req.params.id), eq(evidence.subtaskId, req.params.id)));

    // 3. Delete suggestions
    await tx.delete(suggestions).where(eq(suggestions.ticketId, req.params.id));

    // 4. Delete deviations
    await tx.delete(deviations).where(eq(deviations.ticketId, req.params.id));

    // 5. Delete validation runs
    await tx.delete(validationRuns).where(eq(validationRuns.ticketId, req.params.id));

    // 6. Delete the ticket itself
    await tx.delete(tickets).where(eq(tickets.id, req.params.id));
  });

  res.status(204).send();
});

export default router;
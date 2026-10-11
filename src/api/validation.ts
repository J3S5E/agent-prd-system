import { Request, Response, Router } from 'express';
import { eq, desc, count } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db/index.js';
import { tickets, repos, validationRuns, idempotencyKeys } from '../db/schema.js';
import { ValidationConfigSchema, GetValidationConfigSchema, SubmitValidationResultsSchema, ValidationConfig } from '../types/validation.js';
import { broadcast } from '../engine/events.js';
import { incrementValidationAttempts, checkValidationCircuitBreaker, getCircuitBreakerState } from '../engine/circuits.js';
import { TicketStatus, TicketStatusEnum } from '../types/ticket.js';

import { trackInFlight } from './inflight.js';

const router = Router();

function getHeader(headers: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const val = headers[key.toLowerCase()];
  return Array.isArray(val) ? val[0] : val;
}

function parseTicketStatusFromDb(status: string): TicketStatus {
  const parsed = TicketStatusEnum.safeParse(status);
  if (!parsed.success) {
    throw new Error(`Invalid ticket status: ${status}`);
  }
  return parsed.data;
}

const IdempotencyKeySchema = z.string().min(1).max(64);

router.post('/:repo/validate', async (req: Request, res: Response) => {
  const release = trackInFlight();
  try {
    const parse = GetValidationConfigSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
    }
    
    const { ticketId } = parse.data;
    const idempotencyKey = getHeader(req.headers, 'idempotency-key');
    
    if (idempotencyKey) {
      const keyParse = IdempotencyKeySchema.safeParse(idempotencyKey);
      if (!keyParse.success) {
        return res.status(400).json({ error: 'Invalid Idempotency-Key header' });
      }
      
      // Check idempotency key storage
      const existingKey = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, idempotencyKey)).limit(1);
      if (existingKey.length > 0) {
        const keyRecord = existingKey[0];
        const now = Date.now();
        
        if (keyRecord.expiresAt > now) {
          // Return cached response
          return res.json(JSON.parse(keyRecord.response));
        } else {
          // Expired, delete it
          await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, idempotencyKey));
        }
      }
    }
    
    // Get ticket
    const ticket = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
    if (ticket.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    
    // Get repo config
    const repoConfig = await db.select().from(repos).where(eq(repos.name, req.params.repo)).limit(1);
    if (repoConfig.length === 0) {
      return res.status(404).json({ error: 'Repo not found' });
    }
    
    const defaultWorktreeBase = process.env.PRD_WORKTREE_BASE || '.';
    let validationConfig: ValidationConfig = { worktreeBase: defaultWorktreeBase, checks: [], maxConcurrent: 2 };
    if (repoConfig[0].validationConfig) {
      try {
        const validated = ValidationConfigSchema.safeParse(JSON.parse(repoConfig[0].validationConfig));
        if (validated.success) {
          validationConfig = validated.data;
        }
      } catch {
        // Invalid config, use defaults
      }
    }
    
    const runId = crypto.randomUUID();
    
    // Update ticket status to NEEDS_VALIDATION if it's not already
    if (ticket[0].status !== 'NEEDS_VALIDATION') {
      await db.update(tickets).set({ status: 'NEEDS_VALIDATION', updatedAt: Date.now() }).where(eq(tickets.id, ticketId));
      broadcast({ type: 'ticket:status_changed', ticketId, from: parseTicketStatusFromDb(ticket[0].status), to: 'NEEDS_VALIDATION' });
    }
    
    broadcast({ type: 'validation:started', ticketId, checkCount: validationConfig.checks.length });
    
    const response = {
      runId,
      config: validationConfig,
      ticket: {
        id: ticket[0].id,
        worktreeDir: ticket[0].worktreeDir,
        repo: ticket[0].repo,
        targetBranch: ticket[0].targetBranch,
        featureBranch: ticket[0].featureBranch,
      },
    };
    
    // Store idempotency key if provided
    if (idempotencyKey) {
      const now = Date.now();
      const expiresAt = now + 24 * 60 * 60 * 1000; // 24 hours
      
      await db.insert(idempotencyKeys).values({
        key: idempotencyKey,
        response: JSON.stringify(response),
        createdAt: now,
        expiresAt,
      });
    }
    
    res.json(response);
  } finally {
    release();
  }
});

router.get('/tickets/:id/validation-runs', async (req: Request, res: Response) => {
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
    .from(validationRuns)
    .where(eq(validationRuns.ticketId, req.params.id));
  const total = Number(totalResult[0]?.count || 0);
  
  const results = await db
    .select()
    .from(validationRuns)
    .where(eq(validationRuns.ticketId, req.params.id))
    .orderBy(desc(validationRuns.createdAt))
    .limit(limit)
    .offset(offset);
  
  res.setHeader('X-Total-Count', total.toString());
  res.json(results);
});

router.post('/tickets/:id/validation-runs/:runId/rerun', async (req: Request, res: Response) => {
  const release = trackInFlight();
  try {
    // Get ticket
    const ticket = await db.select().from(tickets).where(eq(tickets.id, req.params.id)).limit(1);
    if (ticket.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    
    // Get repo config
    const repoConfig = await db.select().from(repos).where(eq(repos.name, ticket[0].repo)).limit(1);
    if (repoConfig.length === 0) {
      return res.status(404).json({ error: 'Repo not found' });
    }
    
    const defaultWorktreeBase = process.env.PRD_WORKTREE_BASE || '.';
    let validationConfig: ValidationConfig = { worktreeBase: defaultWorktreeBase, checks: [], maxConcurrent: 2 };
    if (repoConfig[0].validationConfig) {
      try {
        const validated = ValidationConfigSchema.safeParse(JSON.parse(repoConfig[0].validationConfig));
        if (validated.success) {
          validationConfig = validated.data;
        }
      } catch {
        // Invalid config, use defaults
      }
    }
    
    const runId = crypto.randomUUID();
    
    broadcast({ type: 'validation:started', ticketId: req.params.id, checkCount: validationConfig.checks.length });
    
    res.json({
      runId,
      config: validationConfig,
      ticket: {
        id: ticket[0].id,
        worktreeDir: ticket[0].worktreeDir,
        repo: ticket[0].repo,
        targetBranch: ticket[0].targetBranch,
        featureBranch: ticket[0].featureBranch,
      },
    });
  } finally {
    release();
  }
});

router.post('/tickets/:id/validation-results', async (req: Request, res: Response) => {
  const release = trackInFlight();
  try {
    const parse = SubmitValidationResultsSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
    }
    
    const { runId, results } = parse.data;
    
    const ticket = await db.select().from(tickets).where(eq(tickets.id, req.params.id)).limit(1);
    if (ticket.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    
    const allPassed = results.every(r => r.passed);
    const now = Date.now();
    
    // Insert validation runs
    for (const result of results) {
      await db.insert(validationRuns).values({
        id: runId,
        ticketId: req.params.id,
        checkName: result.checkName,
        command: '', // Would need to be passed from ralph.js
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        passed: result.passed,
        createdAt: now,
      });
    }
    
    if (allPassed) {
      // Advance to NEEDS_REVIEW
      await db.update(tickets).set({ status: 'NEEDS_REVIEW', updatedAt: now }).where(eq(tickets.id, req.params.id));
      broadcast({ type: 'ticket:status_changed', ticketId: req.params.id, from: parseTicketStatusFromDb(ticket[0].status), to: 'NEEDS_REVIEW' });
      broadcast({ type: 'validation:completed', ticketId: req.params.id, passed: true, runs: [] });
    } else {
      // Increment validation attempts
      await incrementValidationAttempts(req.params.id);
      
      // Check circuit breaker
      const state = await getCircuitBreakerState(req.params.id);
      if (state) {
        const circuit = checkValidationCircuitBreaker(state);
        if (circuit.tripped) {
          await db.update(tickets).set({ status: circuit.targetStatus!, updatedAt: now }).where(eq(tickets.id, req.params.id));
          broadcast({ type: 'ticket:status_changed', ticketId: req.params.id, from: parseTicketStatusFromDb(ticket[0].status), to: circuit.targetStatus! });
          broadcast({ type: 'ticket:flagged', ticketId: req.params.id, reason: 'Validation failed 3 times' });
        } else {
          // Move to NEEDS_IMPLEMENTATION_UPDATE
          await db.update(tickets).set({ status: 'NEEDS_IMPLEMENTATION_UPDATE', updatedAt: now }).where(eq(tickets.id, req.params.id));
          broadcast({ type: 'ticket:status_changed', ticketId: req.params.id, from: parseTicketStatusFromDb(ticket[0].status), to: 'NEEDS_IMPLEMENTATION_UPDATE' });
        }
      }
      broadcast({ type: 'validation:completed', ticketId: req.params.id, passed: false, runs: [] });
    }
    
    res.json({ success: true, allPassed });
  } finally {
    release();
  }
});

export default router;
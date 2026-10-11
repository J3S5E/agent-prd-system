import { Request, Response, Router } from 'express';
import { eq, count } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db/index.js';
import { repos, tickets } from '../db/schema.js';
import { ValidationConfigSchema } from '../types/validation.js';


const router = Router();

const RepoCreateSchema = z.object({
  name: z.string().min(1),
  worktreeBase: z.string().optional(),
  validationConfig: ValidationConfigSchema.optional(),
});

const RepoUpdateSchema = z.object({
  worktreeBase: z.string().optional(),
  validationConfig: ValidationConfigSchema.optional(),
});

router.get('/', async (req: Request, res: Response) => {
  const allRepos = await db.select().from(repos);
  
  // Get ticket counts per repo per status
  const ticketCounts = await db
    .select({
      repo: tickets.repo,
      status: tickets.status,
      count: count(),
    })
    .from(tickets)
    .groupBy(tickets.repo, tickets.status);
  
  const reposWithCounts = allRepos.map(repo => {
    const counts: Record<string, number> = {};
    for (const tc of ticketCounts) {
      if (tc.repo === repo.name) {
        counts[tc.status] = Number(tc.count);
      }
    }
    return { ...repo, ticketCounts: counts };
  });
  
  res.json(reposWithCounts);
});

router.get('/:repo', async (req: Request, res: Response) => {
  const repo = await db.select().from(repos).where(eq(repos.name, req.params.repo)).limit(1);
  
  if (repo.length === 0) {
    return res.status(404).json({ error: 'Repo not found' });
  }
  
  res.json(repo[0]);
});

router.post('/', async (req: Request, res: Response) => {
  const parse = RepoCreateSchema.safeParse(req.body);
  
  if (!parse.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
  }
  
  const { name, worktreeBase, validationConfig } = parse.data;
  
  try {
    const existing = await db.select().from(repos).where(eq(repos.name, name)).limit(1);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Repo already exists' });
    }
    
    const defaultWorktreeBase = process.env.PRD_WORKTREE_BASE || '.';
    await db.insert(repos).values({
      name,
      worktreeBase: worktreeBase || defaultWorktreeBase,
      validationConfig: validationConfig ? JSON.stringify(validationConfig) : null,
      createdAt: Date.now(),
    });
    
    const created = await db.select().from(repos).where(eq(repos.name, name)).limit(1);
    res.status(201).json(created[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create repo', details: err instanceof Error ? err.message : 'Unknown error' });
  }
});

router.patch('/:repo', async (req: Request, res: Response) => {
  const parse = RepoUpdateSchema.safeParse(req.body);
  
  if (!parse.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parse.error.issues });
  }
  
  const { worktreeBase, validationConfig } = parse.data;
  
  const existing = await db.select().from(repos).where(eq(repos.name, req.params.repo)).limit(1);
  if (existing.length === 0) {
    return res.status(404).json({ error: 'Repo not found' });
  }
  
  const updates: Record<string, unknown> = { updatedAt: Date.now() };
  if (worktreeBase !== undefined) updates.worktreeBase = worktreeBase;
  if (validationConfig !== undefined) updates.validationConfig = JSON.stringify(validationConfig);
  
  await db.update(repos).set(updates).where(eq(repos.name, req.params.repo));
  
  const updated = await db.select().from(repos).where(eq(repos.name, req.params.repo)).limit(1);
  res.json(updated[0]);
});

router.get('/:repo/validation-checks', async (req: Request, res: Response) => {
  const repo = await db.select().from(repos).where(eq(repos.name, req.params.repo)).limit(1);
  
  if (repo.length === 0) {
    return res.status(404).json({ error: 'Repo not found' });
  }
  
  if (!repo[0].validationConfig) {
    return res.json({ checks: [] });
  }
  
  try {
    const parsed = ValidationConfigSchema.safeParse(JSON.parse(repo[0].validationConfig));
    if (!parsed.success) {
      return res.status(500).json({ error: 'Invalid validation config stored' });
    }
    res.json({ checks: parsed.data.checks });
  } catch {
    res.status(500).json({ error: 'Failed to parse validation config' });
  }
});

export default router;
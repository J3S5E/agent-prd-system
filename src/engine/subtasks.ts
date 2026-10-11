import { eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { tickets } from '../db/schema.js';
import { TicketStatus, TicketStatusEnum } from '../types/ticket.js';

import { validateTransition } from './fsm.js';

const PARALLEL_STAGES = process.env.PRD_SUBTASK_PARALLEL_STAGES === 'true';

export interface SubtaskInfo {
  id: string;
  name: string;
  status: TicketStatus;
  parentTicketId: string;
}

function parseStatus(status: string): TicketStatus {
  const parsed = TicketStatusEnum.safeParse(status);
  if (!parsed.success) {
    throw new Error(`Invalid ticket status: ${status}`);
  }
  return parsed.data;
}

export async function getSubtasks(parentTicketId: string): Promise<SubtaskInfo[]> {
  const results = await db
    .select({
      id: tickets.id,
      name: tickets.name,
      status: tickets.status,
      parentTicketId: tickets.parentTicketId,
    })
    .from(tickets)
    .where(eq(tickets.parentTicketId, parentTicketId));
  
  return results
    .filter(r => r.parentTicketId !== null)
    .map(r => ({
      ...r,
      status: parseStatus(r.status),
      parentTicketId: r.parentTicketId!,
    }));
}

export function canProcessSubtaskParallel(): boolean {
  return PARALLEL_STAGES;
}

export async function areAllSubtasksDone(parentTicketId: string): Promise<boolean> {
  const subtasks = await getSubtasks(parentTicketId);
  if (subtasks.length === 0) return true;
  
  return subtasks.every(st => st.status === 'DONE');
}

export async function getSubtaskStatusCounts(parentTicketId: string): Promise<Record<TicketStatus, number>> {
  const subtasks = await getSubtasks(parentTicketId);
  const counts: Record<string, number> = {};
  
  for (const st of subtasks) {
    counts[st.status] = (counts[st.status] || 0) + 1;
  }
  
  return counts as Record<TicketStatus, number>;
}

export async function advanceSubtaskStage(
  parentTicketId: string,
  targetStage: TicketStatus
): Promise<{ advanced: boolean; nextSubtaskId?: string }> {
  // Find subtasks not yet at target stage
  const subtasks = await getSubtasks(parentTicketId);
  
  // Find the first subtask that needs to be advanced
  for (const subtask of subtasks) {
    const result = validateTransition(subtask.status, targetStage);
    if (result.success) {
      return { advanced: true, nextSubtaskId: subtask.id };
    }
  }
  
  return { advanced: false };
}

export async function getNextSubtaskToProcess(
  parentTicketId: string,
  currentStage: TicketStatus
): Promise<SubtaskInfo | null> {
  const subtasks = await getSubtasks(parentTicketId);
  
  if (PARALLEL_STAGES) {
    // Parallel mode: return any subtask not at DONE and not at currentStage
    for (const subtask of subtasks) {
      if (subtask.status !== 'DONE' && subtask.status !== currentStage) {
        return subtask;
      }
    }
  } else {
    // Sequential mode: only one subtask per stage at a time
    // Check if any subtask is already at currentStage
    const hasSubtaskAtStage = subtasks.some(st => st.status === currentStage);
    if (hasSubtaskAtStage) {
      return null; // Wait for current stage to complete
    }
    // Find first subtask not at DONE
    for (const subtask of subtasks) {
      if (subtask.status !== 'DONE') {
        return subtask;
      }
    }
  }
  
  return null;
}

export function getSubtaskProcessingOrder(): TicketStatus[] {
  return [
    'NEEDS_REFINEMENT',
    'NEEDS_PLAN',
    'READY_PLAN_REVIEW',
    'NEEDS_IMPLEMENTING',
    'NEEDS_VALIDATION',
    'NEEDS_REVIEW',
    'NEEDS_SECURITY_REVIEW',
    'NEEDS_QA',
    'DONE',
  ];
}
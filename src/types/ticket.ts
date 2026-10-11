import { z } from 'zod';

// FSM Status Enum
export const TicketStatusEnum = z.enum([
  'NEEDS_REFINEMENT',
  'NEEDS_PLAN',
  'READY_PLAN_REVIEW',
  'NEEDS_PLAN_UPDATING',
  'NEEDS_IMPLEMENTING',
  'NEEDS_SUBTICKETS_PROCESSED',
  'NEEDS_VALIDATION',
  'NEEDS_IMPLEMENTATION_UPDATE',
  'NEEDS_REVIEW',
  'NEEDS_SECURITY_REVIEW',
  'NEEDS_QA',
  'NEEDS_PR',
  'NEEDS_GIT_MERGE',
  'NEEDS_PR_MAINTENANCE',
  'NEEDS_FINALIZING',
  'NEEDS_CLEANUP',
  'DONE',
  'NEEDS_HUMAN_INTERVENTION',
  'NEEDS_HUMAN_CLARIFICATION',
  'NEEDS_HUMAN_PLAN_REVIEW',
]);

export type TicketStatus = z.infer<typeof TicketStatusEnum>;

// FSM status order for Kanban columns
export const STATUS_ORDER: TicketStatus[] = [
  'NEEDS_REFINEMENT',
  'NEEDS_PLAN',
  'READY_PLAN_REVIEW',
  'NEEDS_PLAN_UPDATING',
  'NEEDS_IMPLEMENTING',
  'NEEDS_SUBTICKETS_PROCESSED',
  'NEEDS_VALIDATION',
  'NEEDS_IMPLEMENTATION_UPDATE',
  'NEEDS_REVIEW',
  'NEEDS_SECURITY_REVIEW',
  'NEEDS_QA',
  'NEEDS_PR',
  'NEEDS_GIT_MERGE',
  'NEEDS_PR_MAINTENANCE',
  'NEEDS_FINALIZING',
  'NEEDS_CLEANUP',
  'DONE',
  'NEEDS_HUMAN_INTERVENTION',
  'NEEDS_HUMAN_CLARIFICATION',
  'NEEDS_HUMAN_PLAN_REVIEW',
];

// Flagged statuses
export const FLAGGED_STATUSES: TicketStatus[] = [
  'NEEDS_HUMAN_INTERVENTION',
  'NEEDS_HUMAN_CLARIFICATION',
  'NEEDS_HUMAN_PLAN_REVIEW',
];

// Ticket schemas
export const CreateTicketSchema = z.object({
  repo: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  targetBranch: z.string().optional(),
  jiraTicket: z.string().optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().default('P2'),
});

export const UpdateTicketSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  plan: z.string().optional(),
  planIssues: z.string().optional(),
  blockingIssues: z.string().optional(),
  reviewComments: z.string().optional(),
  securityNotes: z.string().optional(),
  qaNotes: z.string().optional(),
  featureBranch: z.string().optional(),
  worktreeDir: z.string().optional(),
  targetBranch: z.string().optional(),
  jiraTicket: z.string().optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
});

export const UpdateTicketStatusSchema = z.object({
  newStatus: TicketStatusEnum,
  comment: z.string().optional(),
});

export const UnblockTicketSchema = z.object({
  direction: z.enum(['back', 'forward']),
});

// Subtask schema
export const CreateSubtaskSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

// Type exports
export type CreateTicket = z.infer<typeof CreateTicketSchema>;
export type UpdateTicket = z.infer<typeof UpdateTicketSchema>;
export type UpdateTicketStatus = z.infer<typeof UpdateTicketStatusSchema>;
export type UnblockTicket = z.infer<typeof UnblockTicketSchema>;
export type CreateSubtask = z.infer<typeof CreateSubtaskSchema>;
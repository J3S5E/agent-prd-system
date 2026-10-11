import { sqliteTable, text, integer, index, check, AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm/sql';

// Define tickets table first (self-referential)
export const tickets = sqliteTable('tickets', {
  id: text('id').primaryKey(),
  repo: text('repo').notNull().references(() => repos.name, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull(),
  targetBranch: text('target_branch'),
  featureBranch: text('feature_branch'),
  worktreeDir: text('worktree_dir'),
  plan: text('plan'),
  planIssues: text('plan_issues'),
  blockingIssues: text('blocking_issues'),
  reviewComments: text('review_comments'),
  securityNotes: text('security_notes'),
  qaNotes: text('qa_notes'),
  implementationRetryCount: integer('impl_retry_count').default(0),
  validationAttempts: integer('validation_attempts').default(0),
  planIteration: integer('plan_iteration').default(0),
  parentTicketId: text('parent_ticket_id').references((): AnySQLiteColumn => tickets.id, { onDelete: 'cascade' }),
  jiraTicket: text('jira_ticket'),
  priority: text('priority').default('P2'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => ({
  repoStatusIdx: index('idx_tickets_repo_status').on(table.repo, table.status),
  flaggedIdx: index('idx_tickets_flagged')
    .on(table.repo, table.status)
    .where(sql`status IN ('Needs Human Intervention', 'Needs Human Clarification', 'Needs Human Plan Review')`),
  parentIdx: index('idx_tickets_parent')
    .on(table.parentTicketId)
    .where(sql`parent_ticket_id IS NOT NULL`),
}));

// evidence - file artifacts
// CHECK constraint: exactly one of ticketId or subtaskId is non-null
export const evidence = sqliteTable('evidence', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
  subtaskId: text('subtask_id').references(() => tickets.id, { onDelete: 'cascade' }),
  filePath: text('file_path'),
  content: text('content'),
  contentType: text('content_type').notNull(),
  source: text('source').notNull(),
  type: text('type').notNull(),
  passed: integer('passed', { mode: 'boolean' }),
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  ticketIdx: index('idx_evidence_ticket').on(table.ticketId),
  subtaskIdx: index('idx_evidence_subtask').on(table.subtaskId),
  sourcePassedIdx: index('idx_evidence_source_passed').on(table.source, table.passed),
  // CHECK (ticket_id IS NOT NULL) != (subtask_id IS NOT NULL) -- exactly one parent
  oneParentCheck: check('evidence_one_parent', 
    sql`(ticket_id IS NOT NULL) != (subtask_id IS NOT NULL)`
  ),
}));

// suggestions - out-of-scope observations
export const suggestions = sqliteTable('suggestions', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),
  description: text('description').notNull(),
  resolved: integer('resolved', { mode: 'boolean' }).default(false),
  resolvedAt: integer('resolved_at'),
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  ticketIdx: index('idx_suggestions_ticket').on(table.ticketId),
}));

// deviations - intentional plan changes
export const deviations = sqliteTable('deviations', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
  action: text('action').notNull(),
  description: text('description').notNull(),
  reviewApproved: integer('review_approved', { mode: 'boolean' }).default(false),
  qaApproved: integer('qa_approved', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  ticketIdx: index('idx_deviations_ticket').on(table.ticketId),
}));

// validation_runs - check execution history
export const validationRuns = sqliteTable('validation_runs', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
  checkName: text('check_name').notNull(),
  command: text('command').notNull(),
  stdout: text('stdout'),
  stderr: text('stderr'),
  exitCode: integer('exit_code'),
  passed: integer('passed', { mode: 'boolean' }).notNull(),
  evidenceId: text('evidence_id'),
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  ticketIdx: index('idx_validation_runs_ticket').on(table.ticketId),
}));

// repos - repository configuration
export const repos = sqliteTable('repos', {
  name: text('name').primaryKey(),
  worktreeBase: text('worktree_base').default('.'),
  validationConfig: text('validation_config'),
  createdAt: integer('created_at').notNull(),
});

// api_logs - API request/response + internal event history
export const apiLogs = sqliteTable('api_logs', {
  id: text('id').primaryKey(),
  endpoint: text('endpoint'),
  method: text('method'),
  requestBody: text('request_body'),
  responseStatus: integer('response_status'),
  ticketId: text('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  eventType: text('event_type'),
  eventData: text('event_data'),
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  ticketIdx: index('idx_api_logs_ticket').on(table.ticketId),
  createdIdx: index('idx_api_logs_created').on(table.createdAt),
  eventTypeIdx: index('idx_api_logs_event_type').on(table.eventType),
}));

// ralph_instances - registered ralph daemon instances
export const ralphInstances = sqliteTable('ralph_instances', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(), // e.g., ralph_alpha, ralph_beta
  repo: text('repo').notNull(),
  status: text('status').notNull().default('idle'), // idle, busy, offline
  currentTicketId: text('current_ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  lastHeartbeat: integer('last_heartbeat').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  repoIdx: index('idx_ralph_instances_repo').on(table.repo),
  statusIdx: index('idx_ralph_instances_status').on(table.status),
}));

// ticket_locks - distributed lock for ticket processing
export const ticketLocks = sqliteTable('ticket_locks', {
  ticketId: text('ticket_id').primaryKey().references(() => tickets.id, { onDelete: 'cascade' }),
  ralphInstanceId: text('ralph_instance_id').notNull().references(() => ralphInstances.id, { onDelete: 'cascade' }),
  lockedAt: integer('locked_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  lockType: text('lock_type').notNull(), // 'validation' | 'processing'
}, (table) => ({
  ralphIdx: index('idx_ticket_locks_ralph').on(table.ralphInstanceId),
  expiresIdx: index('idx_ticket_locks_expires').on(table.expiresAt),
}));

// Type exports for inference
export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;
export type Evidence = typeof evidence.$inferSelect;
export type NewEvidence = typeof evidence.$inferInsert;
export type Suggestion = typeof suggestions.$inferSelect;
export type NewSuggestion = typeof suggestions.$inferInsert;
export type Deviation = typeof deviations.$inferSelect;
export type NewDeviation = typeof deviations.$inferInsert;
export type ValidationRun = typeof validationRuns.$inferSelect;
export type NewValidationRun = typeof validationRuns.$inferInsert;
export type Repo = typeof repos.$inferSelect;
export type NewRepo = typeof repos.$inferInsert;
export type RalphInstance = typeof ralphInstances.$inferSelect;
export type NewRalphInstance = typeof ralphInstances.$inferInsert;

export type ApiLog = typeof apiLogs.$inferSelect;
export type NewApiLog = typeof apiLogs.$inferInsert;

export type TicketLock = typeof ticketLocks.$inferSelect;
export type NewTicketLock = typeof ticketLocks.$inferInsert;
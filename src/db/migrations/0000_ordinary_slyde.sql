CREATE TABLE `api_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint` text,
	`method` text,
	`request_body` text,
	`response_status` integer,
	`ticket_id` text,
	`event_type` text,
	`event_data` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_api_logs_ticket` ON `api_logs` (`ticket_id`);--> statement-breakpoint
CREATE INDEX `idx_api_logs_created` ON `api_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_api_logs_event_type` ON `api_logs` (`event_type`);--> statement-breakpoint
CREATE TABLE `deviations` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text,
	`action` text NOT NULL,
	`description` text NOT NULL,
	`review_approved` integer DEFAULT false,
	`qa_approved` integer DEFAULT false,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_deviations_ticket` ON `deviations` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text,
	`subtask_id` text,
	`file_path` text,
	`content` text,
	`content_type` text NOT NULL,
	`source` text NOT NULL,
	`type` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subtask_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "evidence_one_parent" CHECK((ticket_id IS NOT NULL) != (subtask_id IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_evidence_ticket` ON `evidence` (`ticket_id`);--> statement-breakpoint
CREATE INDEX `idx_evidence_subtask` ON `evidence` (`subtask_id`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`response` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_idempotency_keys_expires` ON `idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `ralph_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`current_ticket_id` text,
	`last_heartbeat` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`current_ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ralph_instances_name_unique` ON `ralph_instances` (`name`);--> statement-breakpoint
CREATE INDEX `idx_ralph_instances_repo` ON `ralph_instances` (`repo`);--> statement-breakpoint
CREATE INDEX `idx_ralph_instances_status` ON `ralph_instances` (`status`);--> statement-breakpoint
CREATE TABLE `repos` (
	`name` text PRIMARY KEY NOT NULL,
	`worktree_base` text DEFAULT '.',
	`validation_config` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text,
	`source` text NOT NULL,
	`description` text NOT NULL,
	`resolved` integer DEFAULT false,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_suggestions_ticket` ON `suggestions` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `ticket_locks` (
	`ticket_id` text PRIMARY KEY NOT NULL,
	`ralph_instance_id` text NOT NULL,
	`locked_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`lock_type` text NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ralph_instance_id`) REFERENCES `ralph_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ticket_locks_ralph` ON `ticket_locks` (`ralph_instance_id`);--> statement-breakpoint
CREATE INDEX `idx_ticket_locks_expires` ON `ticket_locks` (`expires_at`);--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`target_branch` text,
	`feature_branch` text,
	`worktree_dir` text,
	`plan` text,
	`plan_issues` text,
	`blocking_issues` text,
	`review_comments` text,
	`security_notes` text,
	`qa_notes` text,
	`impl_retry_count` integer DEFAULT 0,
	`validation_attempts` integer DEFAULT 0,
	`plan_iteration` integer DEFAULT 0,
	`parent_ticket_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repo`) REFERENCES `repos`(`name`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`parent_ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tickets_repo_status` ON `tickets` (`repo`,`status`);--> statement-breakpoint
CREATE INDEX `idx_tickets_flagged` ON `tickets` (`repo`,`status`) WHERE status IN ('Needs Human Intervention', 'Needs Human Clarification', 'Needs Human Plan Review');--> statement-breakpoint
CREATE INDEX `idx_tickets_parent` ON `tickets` (`parent_ticket_id`) WHERE parent_ticket_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `validation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text,
	`check_name` text NOT NULL,
	`command` text NOT NULL,
	`stdout` text,
	`stderr` text,
	`exit_code` integer,
	`passed` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_validation_runs_ticket` ON `validation_runs` (`ticket_id`);
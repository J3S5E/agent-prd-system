DROP TABLE `idempotency_keys`;--> statement-breakpoint
ALTER TABLE `evidence` ADD `passed` integer;--> statement-breakpoint
CREATE INDEX `idx_evidence_source_passed` ON `evidence` (`source`,`passed`);--> statement-breakpoint
ALTER TABLE `validation_runs` ADD `evidence_id` text;
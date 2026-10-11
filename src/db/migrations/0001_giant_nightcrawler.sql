ALTER TABLE `tickets` ADD `jira_ticket` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `priority` text DEFAULT 'P2';
CREATE TABLE `scheduled_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text NOT NULL,
	`name` text,
	`instruction` text NOT NULL,
	`recurrence` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_fired_local_date` text,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scheduled_tasks_chat_id_idx` ON `scheduled_tasks` (`chat_id`);

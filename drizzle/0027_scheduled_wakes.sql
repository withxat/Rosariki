CREATE TABLE `scheduled_wakes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text NOT NULL,
	`run_at_ms` integer NOT NULL,
	`instruction` text NOT NULL,
	`repeat_interval_ms` integer,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at_ms` integer NOT NULL,
	`last_fired_at_ms` integer
);
--> statement-breakpoint
CREATE INDEX `scheduled_wakes_run_at_idx` ON `scheduled_wakes` (`run_at_ms`);
--> statement-breakpoint
CREATE INDEX `scheduled_wakes_chat_id_idx` ON `scheduled_wakes` (`chat_id`);

ALTER TABLE `compactions` ADD `cache_read_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `compactions` ADD `cache_write_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `probe_responses_v2` ADD `cache_read_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `probe_responses_v2` ADD `cache_write_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `turn_responses_v2` ADD `cache_read_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `turn_responses_v2` ADD `cache_write_tokens` integer DEFAULT 0 NOT NULL;
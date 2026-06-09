DROP TABLE `scheduled_wakes`;
--> statement-breakpoint
DELETE FROM `events` WHERE `type` = 'runtime' AND json_extract(`runtime_data`, '$.kind') = 'scheduled_wake';

CREATE TABLE `server_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notif_kind_day` ON `notification_log` (`kind`,`day_key`,`sent_at`);--> statement-breakpoint
CREATE INDEX `notif_sent` ON `notification_log` (`sent_at`);
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`icon` text NOT NULL,
	`sort_order` integer NOT NULL,
	`exempt_from_stale_check` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `categories_synced` ON `categories` (`synced_at`);--> statement-breakpoint
CREATE TABLE `notification_log` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`rule_id` text,
	`segment_id` text,
	`day_key` text,
	`sent_at` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notif_rule_segment` ON `notification_log` (`rule_id`,`segment_id`,`sent_at`);--> statement-breakpoint
CREATE INDEX `notif_rule_day` ON `notification_log` (`rule_id`,`day_key`,`sent_at`);--> statement-breakpoint
CREATE INDEX `notif_kind_segment` ON `notification_log` (`kind`,`segment_id`,`sent_at`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` text NOT NULL,
	`last_success_at` text,
	`failure_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`kind` text NOT NULL,
	`threshold_min` integer NOT NULL,
	`repeat_every_min` integer,
	`quiet_start` text,
	`quiet_end` text,
	`message` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`synced_at` text NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "rules_kind" CHECK(kind IN ('session', 'daily'))
);
--> statement-breakpoint
CREATE INDEX `rules_synced` ON `rules` (`synced_at`);--> statement-breakpoint
CREATE TABLE `segments` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`note` text,
	`source` text DEFAULT 'app' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`synced_at` text NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `segments_started` ON `segments` (`started_at`);--> statement-breakpoint
CREATE INDEX `segments_cat_started` ON `segments` (`category_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `segments_ended` ON `segments` (`ended_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `segments_one_open` ON `segments` ((ended_at IS NULL)) WHERE ended_at IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `segments_synced` ON `segments` (`synced_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`timezone` text NOT NULL,
	`day_start_hour` integer DEFAULT 4 NOT NULL,
	`stale_enabled` integer DEFAULT 1 NOT NULL,
	`stale_after_min` integer DEFAULT 300 NOT NULL,
	`stale_repeat_min` integer DEFAULT 60,
	`stale_quiet_start` text,
	`stale_quiet_end` text,
	`updated_at` text NOT NULL,
	`synced_at` text NOT NULL,
	CONSTRAINT "settings_singleton" CHECK(id = 'singleton')
);
--> statement-breakpoint
CREATE INDEX `settings_synced` ON `settings` (`synced_at`);
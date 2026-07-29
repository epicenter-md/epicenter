ALTER TABLE "tiktok_connection" ADD COLUMN "closing_at" timestamp;--> statement-breakpoint
ALTER TABLE "tiktok_publish_attempt" ADD COLUMN "lease_expires_at" timestamp;
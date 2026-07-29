CREATE TABLE "tiktok_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"open_id" text NOT NULL,
	"union_id" text,
	"display_name" text NOT NULL,
	"username" text,
	"avatar_url" text,
	"scopes" text[] NOT NULL,
	"access_token_ciphertext" text NOT NULL,
	"access_token_expires_at" timestamp NOT NULL,
	"refresh_token_ciphertext" text NOT NULL,
	"refresh_token_expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tiktok_connection_userId_openId_unique" UNIQUE("user_id","open_id")
);
--> statement-breakpoint
CREATE TABLE "tiktok_oauth_state" (
	"state" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code_verifier" text NOT NULL,
	"return_path" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tiktok_publish_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" text NOT NULL,
	"publish_id" text,
	"status" text,
	"fail_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tiktok_publish_attempt_connectionId_idempotencyKey_unique" UNIQUE("connection_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "tiktok_connection" ADD CONSTRAINT "tiktok_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tiktok_oauth_state" ADD CONSTRAINT "tiktok_oauth_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tiktok_publish_attempt" ADD CONSTRAINT "tiktok_publish_attempt_connection_id_tiktok_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tiktok_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tiktokConnection_userId_idx" ON "tiktok_connection" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tiktokOauthState_userId_idx" ON "tiktok_oauth_state" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tiktokOauthState_expiresAt_idx" ON "tiktok_oauth_state" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "tiktokPublishAttempt_connectionId_idx" ON "tiktok_publish_attempt" USING btree ("connection_id");
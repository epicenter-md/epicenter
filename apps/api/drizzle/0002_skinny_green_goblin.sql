CREATE TABLE "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp,
	"aaguid" text
);
--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "subject_type" text;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "passkey_userId_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_credentialID_idx" ON "passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauth_access_token" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_sessionId_idx" ON "oauth_access_token" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauth_access_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_refreshId_idx" ON "oauth_access_token" USING btree ("refresh_id");--> statement-breakpoint
CREATE INDEX "oauthClient_userId_idx" ON "oauth_client" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauthConsent_clientId_idx" ON "oauth_consent" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauthConsent_userId_idx" ON "oauth_consent" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_clientId_idx" ON "oauth_refresh_token" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_sessionId_idx" ON "oauth_refresh_token" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_userId_idx" ON "oauth_refresh_token" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_token_unique" UNIQUE("token");
CREATE TABLE "durable_object_instance" (
	"user_id" text NOT NULL,
	"do_type" text NOT NULL,
	"resource_name" text NOT NULL,
	"do_name" text PRIMARY KEY NOT NULL,
	"storage_bytes" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp DEFAULT now() NOT NULL,
	"storage_measured_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "durable_object_instance" ADD CONSTRAINT "durable_object_instance_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doi_user_id_idx" ON "durable_object_instance" USING btree ("user_id");
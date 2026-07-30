CREATE TABLE "storage_observation" (
	"principal_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"observed_bytes" bigint NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "storage_observation_principal_id_source_kind_source_id_pk" PRIMARY KEY("principal_id","source_kind","source_id")
);

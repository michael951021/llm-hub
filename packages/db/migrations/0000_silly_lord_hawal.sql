CREATE TABLE IF NOT EXISTS "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"node_id" uuid NOT NULL,
	"local_id" text NOT NULL,
	"kind" text NOT NULL,
	"index" integer DEFAULT 0 NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"wired_limit_bytes" bigint DEFAULT 0 NOT NULL,
	"driver_version" text DEFAULT '' NOT NULL,
	"compute_capability" text DEFAULT '' NOT NULL,
	"interactive" boolean DEFAULT false NOT NULL,
	"last_used_bytes" bigint DEFAULT 0 NOT NULL,
	"last_managed_bytes" bigint DEFAULT 0 NOT NULL,
	"last_utilization" double precision DEFAULT 0 NOT NULL,
	"last_pressure" text DEFAULT 'normal' NOT NULL,
	"last_sample_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"platform" text DEFAULT '' NOT NULL,
	"arch" text DEFAULT '' NOT NULL,
	"os_version" text DEFAULT '' NOT NULL,
	"agent_version" text DEFAULT '' NOT NULL,
	"hostname" text DEFAULT '' NOT NULL,
	"total_memory_bytes" bigint DEFAULT 0 NOT NULL,
	"cpu_cores" integer DEFAULT 0 NOT NULL,
	"public_key" "bytea" NOT NULL,
	"site_id" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pairing_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"node_name" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_node_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pairing_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "devices" ADD CONSTRAINT "devices_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "devices" ADD CONSTRAINT "devices_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "nodes" ADD CONSTRAINT "nodes_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_used_by_node_id_nodes_id_fk" FOREIGN KEY ("used_by_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "devices_node_local_idx" ON "devices" USING btree ("node_id","local_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "devices_org_idx" ON "devices" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nodes_org_idx" ON "nodes" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "nodes_public_key_idx" ON "nodes" USING btree ("public_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pairing_codes_org_idx" ON "pairing_codes" USING btree ("org_id");
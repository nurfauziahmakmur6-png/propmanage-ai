ALTER TABLE "agent_runs" ADD COLUMN "triggering_message_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "status" text DEFAULT 'sent' NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "citations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "escalated_at" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "escalation_reason" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_triggering_message_id_ticket_messages_id_fk" FOREIGN KEY ("triggering_message_id") REFERENCES "public"."ticket_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_runs_ticket_message_idx" ON "agent_runs" USING btree ("ticket_id","triggering_message_id");
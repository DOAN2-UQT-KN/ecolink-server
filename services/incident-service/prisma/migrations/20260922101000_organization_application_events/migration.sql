-- Audit trail for applications. Survives the retention purge on purpose: once the documents
-- and legal_rep_* columns are erased, this is the only evidence a review happened.
-- Rollback: DROP TABLE "organization_application_events";

-- CreateTable
CREATE TABLE "organization_application_events" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "event_type" VARCHAR(40) NOT NULL,
    "actor_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_application_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organization_application_events_application_id_created_at_idx" ON "organization_application_events"("application_id", "created_at");

-- AddForeignKey
ALTER TABLE "organization_application_events" ADD CONSTRAINT "organization_application_events_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "organization_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

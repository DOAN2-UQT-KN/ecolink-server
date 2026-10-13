-- Owner changes (phase 3 of docs/ORG_OWNERSHIP_FLOW.md). ADD_OWNER / REMOVE_OWNER /
-- TRANSFER_OWNER are decided inside the organization: the people concerned confirm by email
-- (organization_application_owners) and the other owners approve (the table below). No
-- platform admin review any more.
-- Rollback: DROP TABLE "organization_owner_change_approvals";
--           ALTER TABLE "organization_applications" DROP COLUMN "target_user_id", DROP COLUMN "demote_to_role";

ALTER TABLE "organization_applications"
    ADD COLUMN "target_user_id" UUID,
    ADD COLUMN "demote_to_role" VARCHAR(32);

CREATE INDEX "organization_applications_organization_id_type_status_idx"
    ON "organization_applications"("organization_id", "type", "status");

CREATE TABLE "organization_owner_change_approvals" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "approver_user_id" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "decided_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_owner_change_approvals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "organization_owner_change_approvals_application_id_approver_user_id_key"
    ON "organization_owner_change_approvals"("application_id", "approver_user_id");
CREATE INDEX "organization_owner_change_approvals_approver_user_id_status_idx"
    ON "organization_owner_change_approvals"("approver_user_id", "status");
CREATE INDEX "organization_owner_change_approvals_status_expires_at_idx"
    ON "organization_owner_change_approvals"("status", "expires_at");

ALTER TABLE "organization_owner_change_approvals"
    ADD CONSTRAINT "organization_owner_change_approvals_application_id_fkey"
    FOREIGN KEY ("application_id") REFERENCES "organization_applications"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ADD_OWNER proposals waiting for a platform admin go back to the owner-change flow; they have
-- no approvers, so the hourly sweeper applies them.
UPDATE "organization_applications"
SET "status" = 'AWAITING_OWNER_CONFIRMATION'
WHERE "type" = 'ADD_OWNER' AND "status" = 'PENDING_REVIEW';

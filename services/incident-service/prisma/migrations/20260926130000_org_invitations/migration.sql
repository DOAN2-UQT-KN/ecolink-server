-- Member invitations (phase 2 of docs/ORG_OWNERSHIP_FLOW.md). Anyone in an organization may
-- invite an existing user as MEMBER; an approver (owner/admin) must approve before the
-- invitee receives a link, and the invitee must accept.
-- Rollback: DROP TABLE "organization_invitations";

CREATE TABLE "organization_invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "inviter_id" UUID NOT NULL,
    "invitee_user_id" UUID NOT NULL,
    "invitee_email" VARCHAR(320) NOT NULL,
    "role" VARCHAR(32) NOT NULL DEFAULT 'MEMBER',
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING_APPROVAL',
    "approved_by" UUID,
    "approved_at" TIMESTAMP(3),
    "token_hash" VARCHAR(64),
    "expires_at" TIMESTAMP(3),
    "responded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "organization_invitations_token_hash_key" ON "organization_invitations"("token_hash");
CREATE INDEX "organization_invitations_organization_id_status_idx" ON "organization_invitations"("organization_id", "status");
CREATE INDEX "organization_invitations_invitee_user_id_status_idx" ON "organization_invitations"("invitee_user_id", "status");

-- One open invitation per person per organization.
CREATE UNIQUE INDEX "organization_invitations_open_unique"
    ON "organization_invitations"("organization_id", "invitee_user_id")
    WHERE "status" IN ('PENDING_APPROVAL', 'SENT');

ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Multi-owner organizations (docs/ORG_OWNERSHIP_FLOW.md).
--
-- A `User` is always a person and an organization never logs in. The link between them is
-- `organization_members.role`. Applications carry a list of owner candidates, and each one
-- has to confirm by email before the application reaches the admin queue.
--
-- DESTRUCTIVE. Existing organizations and applications were dev data provisioned with the
-- old single ORG login, so they are discarded rather than converted. TRUNCATE ... CASCADE
-- propagates the same way as 20260922104500_truncate_legacy_organizations (campaigns,
-- reports, votes, ... are emptied too). Re-seed with `npm run prisma:seed` afterwards and
-- run identity-service's 20260926100000_drop_org_accounts migration.
--
-- There is no rollback.
-- ============================================================================

TRUNCATE TABLE "organization_application_otps";
TRUNCATE TABLE "organization_applications" CASCADE;
TRUNCATE TABLE "organizations" RESTART IDENTITY CASCADE;

-- Organizations: the owner is a membership now, and the per-representative override went
-- away with the ID-hash cap (the cap counts owner memberships per user instead).
ALTER TABLE "organizations"
    DROP COLUMN "owner_id",
    DROP COLUMN "legal_rep_limit_override";

-- Memberships carry the role.
ALTER TABLE "organization_members"
    ADD COLUMN "role" VARCHAR(32) NOT NULL DEFAULT 'MEMBER',
    ADD COLUMN "source" VARCHAR(32),
    ADD COLUMN "source_ref" UUID;

CREATE INDEX "organization_members_user_id_role_idx" ON "organization_members"("user_id", "role");

-- Applications.
ALTER TABLE "organization_applications"
    ADD COLUMN "type" VARCHAR(16) NOT NULL DEFAULT 'NEW_ORG',
    ADD COLUMN "submitter_email" VARCHAR(320) NOT NULL,
    ADD COLUMN "submitted_at" TIMESTAMP(3),
    ADD COLUMN "confirmation_snapshot" JSONB,
    DROP COLUMN "legal_rep_name",
    DROP COLUMN "legal_rep_email",
    DROP COLUMN "account_provisioned_at",
    ALTER COLUMN "status" TYPE VARCHAR(32),
    ALTER COLUMN "status" SET DEFAULT 'DRAFT',
    ALTER COLUMN "org_type" DROP NOT NULL,
    ALTER COLUMN "contact_email" DROP NOT NULL,
    ALTER COLUMN "profile" SET DEFAULT '{}';

CREATE INDEX "organization_applications_status_submitted_at_idx" ON "organization_applications"("status", "submitted_at");
CREATE INDEX "organization_applications_submitter_email_idx" ON "organization_applications"("submitter_email");

-- Owner candidates.
CREATE TABLE "organization_application_owners" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "full_name" VARCHAR(200) NOT NULL,
    "is_legal_rep" BOOLEAN NOT NULL DEFAULT false,
    "national_id_document_id" UUID,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "confirm_token_hash" VARCHAR(64),
    "expires_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "responded_at" TIMESTAMP(3),
    "decline_reason" TEXT,
    "confirm_ip" VARCHAR(64),
    "confirm_ua" VARCHAR(512),
    "resolved_user_id" UUID,
    "removed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_application_owners_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "organization_application_owners_confirm_token_hash_key" ON "organization_application_owners"("confirm_token_hash");
CREATE UNIQUE INDEX "organization_application_owners_application_id_email_key" ON "organization_application_owners"("application_id", "email");
CREATE INDEX "organization_application_owners_email_status_idx" ON "organization_application_owners"("email", "status");

ALTER TABLE "organization_application_owners" ADD CONSTRAINT "organization_application_owners_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "organization_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- "I'm not involved — block future invitations".
CREATE TABLE "owner_invite_blocks" (
    "email" VARCHAR(320) NOT NULL,
    "source_candidate_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_invite_blocks_pkey" PRIMARY KEY ("email")
);

-- ----------------------------------------------------------------------------
-- Invariant: every organization that is not soft-deleted keeps at least one member with an
-- owner role. If it breaks, the organization is orphaned and only a manual DB fix recovers
-- it, so it is enforced here and not only in application code.
--
-- The triggers are DEFERRABLE INITIALLY DEFERRED: they run at COMMIT, so creating the
-- organization and then its owner memberships in the same transaction passes.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_org_has_owner(org_id UUID) RETURNS void AS $$
BEGIN
    IF org_id IS NULL THEN
        RETURN;
    END IF;
    IF EXISTS (
        SELECT 1 FROM "organizations" o
        WHERE o."id" = org_id
          AND o."deleted_at" IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM "organization_members" m
              WHERE m."organization_id" = o."id"
                AND m."deleted_at" IS NULL
                AND m."role" IN ('LEGAL_REPRESENTATIVE', 'OWNER')
          )
    ) THEN
        RAISE EXCEPTION 'ORG_MUST_HAVE_OWNER: organization % has no owner', org_id
            USING ERRCODE = 'check_violation';
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION organization_members_owner_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        PERFORM assert_org_has_owner(OLD."organization_id");
    END IF;
    IF TG_OP = 'UPDATE' AND NEW."organization_id" IS DISTINCT FROM OLD."organization_id" THEN
        PERFORM assert_org_has_owner(NEW."organization_id");
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION organizations_owner_guard() RETURNS trigger AS $$
BEGIN
    PERFORM assert_org_has_owner(NEW."id");
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "organization_members_owner_guard"
    AFTER UPDATE OR DELETE ON "organization_members"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION organization_members_owner_guard();

CREATE CONSTRAINT TRIGGER "organizations_owner_guard"
    AFTER INSERT OR UPDATE OF "deleted_at" ON "organizations"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION organizations_owner_guard();

-- ============================================================================
-- A user is always a person (docs/ORG_OWNERSHIP_FLOW.md). The dedicated ORG login that used
-- to be provisioned for each approved organization is gone: owners are ordinary users with
-- an owner membership in incident-service.
--
-- DESTRUCTIVE. The existing ORG accounts were dev data and are deleted, not converted. Run
-- together with incident-service's 20260926100000_org_multi_owner migration, which empties
-- the organizations they pointed at.
--
-- `password` stays nullable: an approved owner who had no account gets one in
-- PENDING_ACTIVATION with no password until the activation link is redeemed.
--
-- There is no rollback.
-- ============================================================================

-- auth_tokens cascade with their user.
DELETE FROM "users" WHERE "account_type" = 'ORG';

DROP INDEX IF EXISTS "users_provisioned_from_application_id_key";

ALTER TABLE "users"
    DROP COLUMN "account_type",
    DROP COLUMN "provisioned_from_application_id";

DELETE FROM "role_permission_sets"
WHERE "roleId" IN (SELECT "id" FROM "roles" WHERE "name" = 'ORG_OWNER');
DELETE FROM "roles" WHERE "name" = 'ORG_OWNER';

-- Activation links were ORG-only; the token type is now generic.
UPDATE "auth_tokens" SET "type" = 'ACCOUNT_ACTIVATION' WHERE "type" = 'ORG_ACCOUNT_ACTIVATION';

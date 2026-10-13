-- Organizations are operated through a dedicated login the system provisions for them, not
-- through the personal account of whoever submitted the application.
--
-- `password` becomes nullable because such an account exists before anybody has set one
-- (status 3 = PENDING_ACTIVATION until the activation link is redeemed).
-- `provisioned_from_application_id` is unique so re-running the provisioning step for the same
-- application returns the existing account instead of creating a duplicate.
--
-- Rollback (only safe when no ORG account exists):
--   ALTER TABLE "users" DROP COLUMN "account_type",
--     DROP COLUMN "provisioned_from_application_id",
--     ALTER COLUMN "password" SET NOT NULL;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "password" DROP NOT NULL;

-- AlterTable
ALTER TABLE "users"
    ADD COLUMN "account_type" VARCHAR(16) NOT NULL DEFAULT 'PERSONAL',
    ADD COLUMN "provisioned_from_application_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "users_provisioned_from_application_id_key" ON "users"("provisioned_from_application_id");

-- Role used by provisioned organization accounts (same style as 20260731153000_seed_default_roles:
-- id / timestamps come from column defaults, skip if the name already exists).
INSERT INTO "roles" ("name", "description")
VALUES ('ORG_OWNER', 'Organization account provisioned after an approved application')
ON CONFLICT ("name") DO NOTHING;

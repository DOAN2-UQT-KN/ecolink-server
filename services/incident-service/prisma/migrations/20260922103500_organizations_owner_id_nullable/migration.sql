-- The provisioning saga writes the organization before the dedicated ORG login exists, so the
-- row is briefly ownerless. Keeping this NOT NULL would make the saga impossible.
-- Rollback (only safe when no row has a NULL owner):
--   ALTER TABLE "organizations" ALTER COLUMN "owner_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "organizations" ALTER COLUMN "owner_id" DROP NOT NULL;

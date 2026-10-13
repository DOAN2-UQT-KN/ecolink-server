-- Phase 3 owner-change notifications (docs/ORG_OWNERSHIP_FLOW.md):
--   ORG_OWNER_CHANGE_APPROVAL_REQUEST  website + email (by userId), to each co-owner whose approval is needed
--   ORG_OWNER_CHANGE_DECIDED           website, applied / rejected / cancelled, to the proposer and the people concerned
--   ORG_OWNER_REMOVAL_PROPOSED         website + email (by userId), to the owner proposed for removal
--   ORG_OWNER_LEFT                     website, to the remaining owners when one steps down or leaves
-- Rollback: enum values cannot be dropped in Postgres without recreating the type.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_OWNER_CHANGE_APPROVAL_REQUEST';
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_OWNER_CHANGE_DECIDED';
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_OWNER_REMOVAL_PROPOSED';
ALTER TYPE "NotificationKind" ADD VALUE 'ORG_OWNER_LEFT';

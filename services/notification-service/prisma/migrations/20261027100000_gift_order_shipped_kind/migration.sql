-- Gift order tracking (specs/017 FR-050): the owner is told when their gift order ships, with the
-- carrier and tracking code. Rollback: enum values cannot be dropped in Postgres without recreating
-- the type.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'GIFT_ORDER_SHIPPED';

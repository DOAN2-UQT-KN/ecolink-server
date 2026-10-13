-- Ownership transfer (TRANSFER_OWNER) was removed from the product: an owner who wants out
-- adds another owner first, then steps down or leaves. Open transfers are cancelled and
-- their confirmation links stop working (the hash stays so an old link explains itself).
-- Rollback: nothing to undo; the rows stay as history.

UPDATE "organization_application_owners" o
SET "expires_at" = NOW()
FROM "organization_applications" a
WHERE o."application_id" = a."id"
  AND a."type" = 'TRANSFER_OWNER'
  AND a."status" = 'AWAITING_OWNER_CONFIRMATION'
  AND o."status" = 'PENDING';

UPDATE "organization_applications"
SET "status" = 'WITHDRAWN',
    "review_note" = 'Tính năng chuyển giao đã bị gỡ.',
    "reviewed_at" = NOW()
WHERE "type" = 'TRANSFER_OWNER'
  AND "status" = 'AWAITING_OWNER_CONFIRMATION';

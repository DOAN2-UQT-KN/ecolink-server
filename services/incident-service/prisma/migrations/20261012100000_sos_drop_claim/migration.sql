-- SOS: "Nhận xử lý" (claim) is dropped. The owner escalation now only waits for a responder, and
-- a hazardous waste SOS goes to the admins when still not resolved after 2 hours.
ALTER TABLE "sos" DROP COLUMN "claimed_by", DROP COLUMN "claimed_at";

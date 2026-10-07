-- SOS v2 (spec "Ecolink – Cải tiến tính năng SOS"): three types with details, a five-state
-- lifecycle, the shift / meeting point it belongs to, escalation timestamps and the resolution.
-- New tables for the people on their way (`sos_responders`), the notifications sent
-- (`sos_deliveries`, dedup and daily cap) and the volunteers' "available" setting.
-- `status` (Int) is kept for older clients: 1 while open, 17 once closed.
-- Existing rows become manpower SOS: resolved when status = 17, open otherwise.

-- AlterTable
ALTER TABLE "sos" ADD COLUMN     "claimed_at" TIMESTAMP(3),
ADD COLUMN     "claimed_by" UUID,
ADD COLUMN     "details" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "escalated_at" TIMESTAMP(3),
ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "location_updated_at" TIMESTAMP(3),
ADD COLUMN     "meeting_point_id" UUID,
ADD COLUMN     "owner_notified_at" TIMESTAMP(3),
ADD COLUMN     "photo_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "radius_km" DOUBLE PRECISION NOT NULL DEFAULT 3,
ADD COLUMN     "reporter_role" VARCHAR(16),
ADD COLUMN     "resolution_code" VARCHAR(20),
ADD COLUMN     "resolution_note" TEXT,
ADD COLUMN     "resolved_at" TIMESTAMP(3),
ADD COLUMN     "resolved_by" UUID,
ADD COLUMN     "shift_id" UUID,
ADD COLUMN     "state" VARCHAR(16) NOT NULL DEFAULT 'open',
ADD COLUMN     "tier2_sent_at" TIMESTAMP(3),
ADD COLUMN     "type" VARCHAR(16) NOT NULL DEFAULT 'manpower',
ALTER COLUMN "content" DROP NOT NULL,
ALTER COLUMN "phone" DROP NOT NULL,
ALTER COLUMN "status" SET DEFAULT 1;

-- Backfill
UPDATE "sos"
SET "state" = 'resolved', "resolution_code" = 'handled', "resolved_at" = "updated_at", "resolved_by" = "updated_by"
WHERE "status" = 17;
UPDATE "sos" SET "status" = 1 WHERE "status" <> 17;

-- CreateTable
CREATE TABLE "sos_responders" (
    "id" UUID NOT NULL,
    "sos_id" INTEGER NOT NULL,
    "user_id" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "distance_m" DOUBLE PRECISION,
    "arrived_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sos_responders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sos_deliveries" (
    "id" UUID NOT NULL,
    "sos_id" INTEGER NOT NULL,
    "user_id" UUID NOT NULL,
    "tier" INTEGER NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sos_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "volunteer_availabilities" (
    "user_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "schedule" JSONB NOT NULL DEFAULT '[]',
    "approx_lat" DOUBLE PRECISION,
    "approx_lng" DOUBLE PRECISION,
    "location_updated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "volunteer_availabilities_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX "sos_responders_user_id_status_idx" ON "sos_responders"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sos_responders_sos_id_user_id_key" ON "sos_responders"("sos_id", "user_id");

-- One SOS on the way at a time per person (not expressible in Prisma).
CREATE UNIQUE INDEX "sos_responders_one_on_the_way" ON "sos_responders"("user_id") WHERE "status" = 'on_the_way';

-- CreateIndex
CREATE INDEX "sos_deliveries_user_id_created_at_idx" ON "sos_deliveries"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sos_deliveries_sos_id_user_id_kind_key" ON "sos_deliveries"("sos_id", "user_id", "kind");

-- CreateIndex
CREATE INDEX "volunteer_availabilities_enabled_idx" ON "volunteer_availabilities"("enabled");

-- CreateIndex
CREATE INDEX "sos_state_idx" ON "sos"("state");

-- CreateIndex
CREATE INDEX "sos_created_by_created_at_idx" ON "sos"("created_by", "created_at");

-- AddForeignKey
ALTER TABLE "sos" ADD CONSTRAINT "sos_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "campaign_shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sos" ADD CONSTRAINT "sos_meeting_point_id_fkey" FOREIGN KEY ("meeting_point_id") REFERENCES "campaign_meeting_points"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sos_responders" ADD CONSTRAINT "sos_responders_sos_id_fkey" FOREIGN KEY ("sos_id") REFERENCES "sos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sos_deliveries" ADD CONSTRAINT "sos_deliveries_sos_id_fkey" FOREIGN KEY ("sos_id") REFERENCES "sos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

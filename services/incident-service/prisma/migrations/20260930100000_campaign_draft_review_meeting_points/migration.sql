-- Campaign lifecycle, phases 1–2 (Đặc tả luồng chiến dịch): drafts, review decisions,
-- meeting points, audit log.
--   campaigns: contact, safety notes, requirements, revision deadline, submission snapshot
--   campaign_meeting_points: 1–5 gathering points per campaign
--   campaign_meeting_point_reports: which report each point covers (also a draft's selection)
--   campaign_status_logs: every status change and every edit made under review
-- Backfill: one meeting point per existing campaign that has coordinates, covering the
-- reports already linked to it.
-- Rollback:
--   DROP TABLE "campaign_status_logs";
--   DROP TABLE "campaign_meeting_point_reports";
--   DROP TABLE "campaign_meeting_points";
--   ALTER TABLE "campaigns" DROP COLUMN "contact_name", DROP COLUMN "contact_phone",
--     DROP COLUMN "last_submitted_snapshot", DROP COLUMN "requirements",
--     DROP COLUMN "revision_deadline", DROP COLUMN "safety_notes", DROP COLUMN "submitted_at";

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "contact_name" VARCHAR(120),
ADD COLUMN     "contact_phone" VARCHAR(20),
ADD COLUMN     "last_submitted_snapshot" JSONB,
ADD COLUMN     "requirements" JSONB,
ADD COLUMN     "revision_deadline" TIMESTAMP(3),
ADD COLUMN     "safety_notes" TEXT,
ADD COLUMN     "submitted_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "campaign_meeting_points" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "name" VARCHAR(120),
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "detail_address" VARCHAR(255),
    "radius_km" DOUBLE PRECISION NOT NULL,
    "gather_at" TIMESTAMP(3),
    "slots" INTEGER,
    "leader_user_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "campaign_meeting_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_meeting_point_reports" (
    "meeting_point_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_meeting_point_reports_pkey" PRIMARY KEY ("meeting_point_id","report_id")
);

-- CreateTable
CREATE TABLE "campaign_status_logs" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "event" VARCHAR(40) NOT NULL,
    "from_status" INTEGER,
    "to_status" INTEGER,
    "actor_id" UUID,
    "actor_role" VARCHAR(20) NOT NULL,
    "reason" TEXT,
    "changes" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_status_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaign_meeting_points_campaign_id_idx" ON "campaign_meeting_points"("campaign_id");

-- CreateIndex
CREATE INDEX "campaign_meeting_point_reports_report_id_idx" ON "campaign_meeting_point_reports"("report_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_meeting_point_reports_campaign_id_report_id_key" ON "campaign_meeting_point_reports"("campaign_id", "report_id");

-- CreateIndex
CREATE INDEX "campaign_status_logs_campaign_id_created_at_idx" ON "campaign_status_logs"("campaign_id", "created_at");

-- AddForeignKey
ALTER TABLE "campaign_meeting_points" ADD CONSTRAINT "campaign_meeting_points_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_meeting_point_reports" ADD CONSTRAINT "campaign_meeting_point_reports_meeting_point_id_fkey" FOREIGN KEY ("meeting_point_id") REFERENCES "campaign_meeting_points"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_meeting_point_reports" ADD CONSTRAINT "campaign_meeting_point_reports_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_meeting_point_reports" ADD CONSTRAINT "campaign_meeting_point_reports_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_status_logs" ADD CONSTRAINT "campaign_status_logs_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Backfill meeting points for existing campaigns
INSERT INTO "campaign_meeting_points"
  ("id", "campaign_id", "name", "latitude", "longitude", "detail_address", "radius_km",
   "gather_at", "slots", "leader_user_id", "sort_order", "created_by", "updated_by",
   "created_at", "updated_at")
SELECT gen_random_uuid(), c."id", NULL, c."latitude", c."longitude", c."detail_address",
       COALESCE(c."radius_km", 1), c."start_date", NULL, c."created_by", 0,
       c."created_by", c."created_by", NOW(), NOW()
FROM "campaigns" c
WHERE c."deleted_at" IS NULL
  AND c."latitude" IS NOT NULL
  AND c."longitude" IS NOT NULL;

INSERT INTO "campaign_meeting_point_reports" ("meeting_point_id", "report_id", "campaign_id", "created_at")
SELECT mp."id", r."id", r."campaign_id", NOW()
FROM "reports" r
JOIN "campaign_meeting_points" mp ON mp."campaign_id" = r."campaign_id"
WHERE r."campaign_id" IS NOT NULL
  AND r."deleted_at" IS NULL;

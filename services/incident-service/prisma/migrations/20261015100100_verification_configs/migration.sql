-- Report verification (specs/006, plan P04): versioned config for the pipeline, risk engine,
-- checks and category rules. Change a value by inserting a new version and switching is_active
-- (prisma/scripts/verification-config-activate.ts); old versions stay for audit.

-- CreateTable
CREATE TABLE "verification_configs" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "version" VARCHAR(64) NOT NULL,
    "value" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "verification_configs_key_version_key" ON "verification_configs"("key", "version");
-- At most one active version per key (not expressible in Prisma).
CREATE UNIQUE INDEX "verification_configs_one_active_per_key" ON "verification_configs"("key") WHERE "is_active";

-- Seed: starting values from the design doc; recalibrate once moderators have labelled data.
INSERT INTO "verification_configs" ("id", "key", "version", "value", "is_active") VALUES
(uuid_generate_v4(), 'pipeline', '2.3.0', '{"maxAttempts":3,"checkTimeoutMs":10000}', true),
(uuid_generate_v4(), 'engine', 'rules@3.0.0',
 '{"weights":{"DUPLICATE":0.6,"TRUST":0.4,"CONTEXT":0.1},"thresholds":{"review":0.3,"reject":0.7},"duplicateFailedMinFlag":"REVIEW"}', true),
(uuid_generate_v4(), 'checks', 'checks@1.0.0',
 '{"duplicate":{"version":"duplicate@2.0.0","phashGlobalMax":6,"phashCandidateMax":10,"candidateRadiusM":500,"candidateDays":7,"orbMinInliers":25,"orbMinInlierRatio":0.3,"nearbyRadiusM":100,"nearbyHours":24,"risk":{"phashStrict":0.9,"phashLoose":0.75,"orb":0.7,"internet":0.85}},"trust":{"version":"trust@1.0.0","weights":{"capture":0.5,"reject_history":0.35,"account_age":0.15},"galleryRisk":0.6,"rejectWindowDays":90,"smoothing":{"addRejected":1,"addTotal":5},"highRejectMinTotal":3,"highRejectRate":0.5,"accountAgeSteps":[{"belowDays":1,"risk":1.0},{"belowDays":7,"risk":0.4}],"newAccountDays":7},"context":{"version":"context@1.0.0","goongTimeoutMs":3000,"cacheTtlDays":30,"suggestTimeoutMs":2000}}', true),
(uuid_generate_v4(), 'category-rules', 'category-rules@1.0.0',
 '{"WATERWAY":{"kind":"NEARBY_PLACE","keywords":["kênh","rạch","sông","cầu"],"maxDistanceM":300,"missRisk":0.25,"addressHints":["Kênh","Rạch","Sông","Bến"]},"BEACH":{"kind":"NEARBY_PLACE","keywords":["bãi biển","biển"],"maxDistanceM":500,"missRisk":0.5},"MARKET":{"kind":"NEARBY_PLACE","keywords":["chợ"],"maxDistanceM":150,"missRisk":0.5},"SCHOOL":{"kind":"NEARBY_PLACE","keywords":["trường","mầm non","tiểu học","THCS","THPT"],"maxDistanceM":150,"missRisk":0.5},"PARK":{"kind":"NEARBY_PLACE","keywords":["công viên","vườn hoa"],"maxDistanceM":250,"missRisk":0.4},"INDUSTRIAL_ZONE":{"kind":"NEARBY_PLACE","keywords":["khu công nghiệp","KCN","khu chế xuất"],"maxDistanceM":1500,"missRisk":0.4},"ALLEY":{"kind":"ADDRESS_PATTERN","patterns":["/","Hẻm","Ngõ","Kiệt"],"missRisk":0.3},"STREET":{"kind":"ON_STREET","maxDistanceM":50,"missRisk":0.3},"ILLEGAL_DUMP":{"kind":"NONE"},"DRAIN":{"kind":"NONE"},"OPEN_BURNING":{"kind":"NONE"},"OTHER":{"kind":"NONE"}}', true);

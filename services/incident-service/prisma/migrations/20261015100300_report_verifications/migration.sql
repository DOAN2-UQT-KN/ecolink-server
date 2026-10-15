-- Report verification (specs/006, plan P05): one row per pipeline attempt, one child row per check.

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "VerificationCheckName" AS ENUM ('DUPLICATE', 'TRUST', 'CONTEXT');

-- CreateEnum
CREATE TYPE "VerificationCheckStatus" AS ENUM ('COMPLETED', 'SKIPPED', 'FAILED', 'NOT_AVAILABLE');

-- CreateEnum
CREATE TYPE "RiskFlag" AS ENUM ('ACCEPT', 'REVIEW', 'REJECT');

-- CreateTable
CREATE TABLE "report_verifications" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "VerificationStatus" NOT NULL,
    "pipeline_version" VARCHAR(32) NOT NULL,
    "engine_version" VARCHAR(64),
    "risk_score" DOUBLE PRECISION,
    "flag" "RiskFlag",
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "report_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_checks" (
    "id" UUID NOT NULL,
    "verification_id" UUID NOT NULL,
    "check" "VerificationCheckName" NOT NULL,
    "version" VARCHAR(64) NOT NULL,
    "status" "VerificationCheckStatus" NOT NULL,
    "risk" DOUBLE PRECISION,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "signals" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "error" JSONB,
    "duration_ms" INTEGER NOT NULL,

    CONSTRAINT "verification_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_verifications_report_id_attempt_key" ON "report_verifications"("report_id", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "verification_checks_verification_id_check_key" ON "verification_checks"("verification_id", "check");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_latest_verification_id_fkey" FOREIGN KEY ("latest_verification_id") REFERENCES "report_verifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_verifications" ADD CONSTRAINT "report_verifications_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_checks" ADD CONSTRAINT "verification_checks_verification_id_fkey" FOREIGN KEY ("verification_id") REFERENCES "report_verifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;


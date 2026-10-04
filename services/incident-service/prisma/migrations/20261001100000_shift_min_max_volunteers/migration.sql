-- Spec 1.4 (rev. 4): a shift has a minimum number of volunteers (0 = off) and an optional
-- expected maximum; both are warnings, not caps. A day below the difficulty's suggested
-- minimum needs a reason from the creator.
ALTER TABLE "campaign_shifts" RENAME COLUMN "slots" TO "min_volunteers";
ALTER TABLE "campaign_shifts" ADD COLUMN "max_volunteers" INTEGER;
ALTER TABLE "campaigns" ADD COLUMN "min_volunteers_reason" TEXT;

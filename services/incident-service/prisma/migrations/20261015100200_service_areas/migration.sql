-- Report verification (specs/006, plan P02): areas where reports are accepted (BR-113).

-- CreateTable
CREATE TABLE "service_areas" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "geog" geography(MultiPolygon, 4326) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_areas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_areas_geog_gist" ON "service_areas" USING GIST ("geog");

-- shortcut: bbox lấn sang tỉnh lân cận; thay bằng ranh giới hành chính thật (GeoJSON) khi có dữ liệu chính thức.
-- Covers Ho Chi Minh City after the 07/2025 merger (former Binh Duong and Ba Ria - Vung Tau included).
INSERT INTO "service_areas" ("id", "name", "geog", "active") VALUES (uuid_generate_v4(), 'TP.HCM (bbox sau sáp nhập 07/2025)',
  ST_GeogFromText('SRID=4326;MULTIPOLYGON(((106.35 10.30,107.60 10.30,107.60 11.55,106.35 11.55,106.35 10.30)))'), true);

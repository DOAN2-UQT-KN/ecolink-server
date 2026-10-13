-- Legal documents attached to an application. Only the storage handle lives here; the file
-- itself is in private storage and is never served from a public URL.
--
-- `application_id` is nullable because the form uploads paperwork before it submits; until
-- then the row is owned by `submission_email` (the mailbox that passed the OTP).
-- Rollback: DROP TABLE "organization_application_documents";

-- CreateTable
CREATE TABLE "organization_application_documents" (
    "id" UUID NOT NULL,
    "application_id" UUID,
    "submission_email" VARCHAR(320) NOT NULL,
    "doc_type" VARCHAR(32) NOT NULL,
    "storage_key" VARCHAR(512) NOT NULL,
    "format" VARCHAR(8) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "file_name" VARCHAR(255),
    "purged_at" TIMESTAMP(3),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "organization_application_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organization_application_documents_application_id_idx" ON "organization_application_documents"("application_id");

-- CreateIndex
CREATE INDEX "organization_application_documents_submission_email_idx" ON "organization_application_documents"("submission_email");

-- CreateIndex
CREATE INDEX "organization_application_documents_deleted_at_idx" ON "organization_application_documents"("deleted_at");

-- AddForeignKey
ALTER TABLE "organization_application_documents" ADD CONSTRAINT "organization_application_documents_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "organization_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

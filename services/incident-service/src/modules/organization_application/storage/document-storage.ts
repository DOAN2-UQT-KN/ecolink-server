import { Readable } from "stream";

/**
 * Private storage for application legal documents (establishment decisions, licences,
 * representative ID scans).
 *
 * These are personal data, so — unlike logos and banners, which stay on the public
 * Cloudinary preset — nothing here may ever be served from a guessable public URL.
 * The client uploads straight to the provider with short-lived signed parameters the
 * server issues, and only the server can read a file back (it streams it to the admin
 * and writes an audit row). The interface exists so swapping Cloudinary for S3 later
 * touches one file.
 */

/** Everything the browser needs to POST one file directly to the provider. */
export interface SignedUpload {
  /** Where the browser sends the multipart POST. */
  uploadUrl: string;
  /** Form fields that must accompany the file, exactly as given (the signature covers them). */
  fields: Record<string, string>;
  /** Opaque handle we persist on the document row and use to read the file back. */
  storageKey: string;
  /** ISO timestamp after which `fields.signature` is refused by the provider. */
  expiresAt: string;
}

export interface DocumentDownload {
  stream: Readable;
  contentType: string;
  contentLength?: number;
}

export interface CreateSignedUploadInput {
  /** Groups a submission's files together; part of the storage key, never user-controlled. */
  scopeId: string;
  /** `ApplicationDocType`, used only to make stored keys readable. */
  docType: string;
  /** Normalized file extension (`pdf` | `jpg` | `png`). */
  format: string;
}

export interface DocumentStorage {
  createSignedUpload(input: CreateSignedUploadInput): SignedUpload;
  /** Opens the stored file for streaming. `format` comes from the document row. */
  download(storageKey: string, format: string): Promise<DocumentDownload>;
  /** Best-effort removal, used by the retention purge job. */
  remove(storageKey: string, format: string): Promise<void>;
}

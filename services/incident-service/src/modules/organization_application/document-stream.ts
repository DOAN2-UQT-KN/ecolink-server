import { Response } from "express";
import { DocumentDownload } from "./storage/document-storage";

/**
 * Proxies one private legal document to the browser. The file never gets a shareable URL of
 * its own, and `inline` lets the browser preview PDFs and images in place of a download.
 */
export function sendDocumentStream(
  res: Response,
  file: DocumentDownload & { fileName: string },
): void {
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${encodeURIComponent(file.fileName)}"`,
  );
  if (file.contentLength) {
    res.setHeader("Content-Length", String(file.contentLength));
  }
  file.stream.pipe(res);
  file.stream.on("error", (err: unknown) => {
    console.error("[organization-application] document stream:", err);
    res.destroy();
  });
}

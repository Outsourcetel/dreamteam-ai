// pdfExtract — shared PDF→text extraction (unpdf, serverless-friendly pdf.js).
// Extracted from extract-document so the automated/dispatch ingestion paths
// (demo-ingest, connector-driven ingestion) can handle PDFs too, instead of
// PDF support being trapped behind extract-document's browser-JWT entrypoint.
//
// Returns trimmed text, or '' when the PDF has no selectable text (scanned /
// image-only PDFs need OCR, which is not supported here).
import { extractText, getDocumentProxy } from 'https://esm.sh/unpdf@0.12.1';

export const MAX_PDF_BYTES = 15 * 1024 * 1024; // 15 MB

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join('\n\n') : String(text ?? '')).trim();
}

import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerSrc;

export type PdfTextFormat = "markdown" | "text";

type PdfTextItem = {
  str: string;
  transform: number[];
  width?: number;
};

function isTextItem(value: unknown): value is PdfTextItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PdfTextItem>;
  return typeof item.str === "string" && Array.isArray(item.transform);
}

/**
 * Extract readable text from a PDF without uploading the original binary.
 * PDF.js gives us positioned text fragments; grouping fragments by their Y
 * coordinate restores lines well enough for knowledge-base indexing while
 * keeping the operation local to the browser.
 */
type PdfProgress = (page: number, totalPages: number) => void;

export async function pdfToText(
  file: Blob | ArrayBuffer | Uint8Array,
  format: PdfTextFormat = "markdown",
  onProgress?: PdfProgress,
): Promise<string> {
  const data =
    file instanceof Uint8Array ? file
      : file instanceof ArrayBuffer ? new Uint8Array(file)
      : new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocument({ data }).promise;
  const pages: string[] = [];

  try {
    onProgress?.(0, pdf.numPages);
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const items = (textContent.items as unknown[]).filter(isTextItem);
      const lines: { y: number; x: number; text: string }[] = [];

      for (const item of items) {
        const x = Number(item.transform[4] ?? 0);
        const y = Number(item.transform[5] ?? 0);
        const text = item.str.replace(/\s+/g, " ").trim();
        if (!text) continue;
        const line = lines.find((candidate) => Math.abs(candidate.y - y) <= 3);
        if (line) {
          line.text += `${line.text.endsWith(" ") ? "" : " "}${text}`;
          line.x = Math.min(line.x, x);
        } else {
          lines.push({ y, x, text });
        }
      }

      lines.sort((a, b) => b.y - a.y || a.x - b.x);
      pages.push(lines.map((line) => line.text).join("\n").trim());
      onProgress?.(pageNumber, pdf.numPages);
    }
  } finally {
    await pdf.destroy();
  }

  const nonEmptyPages = pages.filter(Boolean);
  if (nonEmptyPages.length === 0) {
    throw new Error("The PDF contains no selectable text. Scanned PDFs need OCR before upload.");
  }
  if (format === "text") return nonEmptyPages.join("\n\n");
  return nonEmptyPages
    .map((page, index) => `## Page ${index + 1}\n\n${page}`)
    .join("\n\n");
}

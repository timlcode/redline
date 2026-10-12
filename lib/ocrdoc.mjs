// Redline — OCR a document page by page: render, recognise, write the invisible text layer.
import * as mupdf from "mupdf";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ocr } from "./ocr/index.mjs";
import { writeTextLayer, pageTextKind } from "./textlayer.mjs";

const MODELS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "models");
export const OCR_DPI = 0; // 0 = adaptive
export const OCR_MIN_DPI = 150;
export const OCR_MAX_DPI = 300;
export const OCR_TARGET_PX = 2000; // long side for ordinary pages; larger sheets are tiled

let enginePromise = null;
export function engine(opts = {}) {
  if (!enginePromise) enginePromise = Ocr.load({ modelsDir: MODELS_DIR, lang: "en", ...opts });
  return enginePromise;
}

/** Pick a raster DPI: ~2000 px on the long side, clamped to 150..300, never above a scan's own resolution. */
export function chooseDpi(page) {
  const b = page.getBounds();
  const longPt = Math.max(b[2] - b[0], b[3] - b[1]) || 792;
  let dpi = Math.max(OCR_MIN_DPI, Math.min(OCR_MAX_DPI, Math.round((OCR_TARGET_PX * 72) / longPt)));
  // A scanned page is one big image: rendering beyond its native resolution only costs time.
  try {
    let native = 0;
    page.toStructuredText("preserve-images").walk({
      onImageBlock(bbox, transform, image) {
        const wPt = Math.abs(bbox[2] - bbox[0]);
        if (wPt > longPt * 0.5) native = Math.max(native, (image.getWidth() * 72) / wPt);
      },
    });
    if (native) dpi = Math.min(dpi, Math.max(OCR_MIN_DPI, Math.round(native)));
  } catch {}
  return dpi;
}

export function rasterizePage(doc, index, dpi = OCR_DPI) {
  const page = doc.loadPage(index);
  if (!dpi) dpi = chooseDpi(page);
  const z = dpi / 72;
  const pix = page.toPixmap(mupdf.Matrix.scale(z, z), mupdf.ColorSpace.DeviceRGB, false, true);
  // Copy out of WASM memory: getPixels() is a view that is detached whenever the heap grows.
  const image = { width: pix.getWidth(), height: pix.getHeight(), data: new Uint8Array(pix.getPixels()) };
  pix.destroy();
  return { zoom: z, dpi, image };
}

/**
 * Recognise one page without touching the document (safe to run while the user edits).
 * Returns { skipped, kind, zoom, dpi, lines, ms }.
 */
export async function recognizePage(doc, index, { dpi = OCR_DPI, force = false } = {}) {
  const kind = pageTextKind(doc, index);
  if (kind === "text" && !force) return { page: index, skipped: true, kind, lines: [], ms: 0 };
  const t0 = performance.now();
  const ocr = await engine();
  const { zoom, image, dpi: usedDpi } = rasterizePage(doc, index, dpi);
  const { lines } = await ocr.run(image);
  return { page: index, skipped: false, kind: "ocr", zoom, dpi: usedDpi, lines, ms: Math.round(performance.now() - t0) };
}

/** Write a recognition result into the page as the invisible text layer (synchronous). */
export function applyPage(doc, rec) {
  if (rec.skipped) return { ...rec, lines: 0, words: 0 };
  const words = writeTextLayer(doc, rec.page, rec.lines, rec.zoom);
  return { page: rec.page, skipped: false, kind: "ocr", dpi: rec.dpi, lines: rec.lines.length, words, ms: rec.ms, text: rec.lines.map((l) => l.text) };
}

/** OCR one page: recognise, then write the layer. Skips pages with native text unless force. */
export async function ocrPage(doc, index, opts = {}) {
  return applyPage(doc, await recognizePage(doc, index, opts));
}

/** Plain text of a page, in reading order, from whatever text the page now has. */
export function pageText(doc, index) {
  return doc.loadPage(index).toStructuredText("preserve-whitespace").asText();
}

/** Search a page. Returns quads in page space (points, origin top-left, y down). */
export function searchPage(doc, index, needle, opts = "") {
  if (!needle) return [];
  const page = doc.loadPage(index);
  const hits = page.search(needle, opts || "ignore-case,ignore-diacritics");
  return hits.map((quads) => quads.map((q) => (Array.isArray(q) ? q : Array.from(q))));
}

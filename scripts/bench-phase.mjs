// One benchmark phase, run in its own process by scripts/bench.mjs.
// mode "before" is the old viewer: structured-text classification and a
// full-page raster. mode "after" is the current path: content-stream sniff
// and the visible tile grid.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import * as P from "../lib/pdf.mjs";
import { pageTextKind } from "../lib/textlayer.mjs";

const VIEW_W = 1100;
const VIEW_H = 800;

function notePeak(state) {
  state.peak = Math.max(state.peak, process.memoryUsage().rss);
}

/** Classification the open path used before the content-stream sniff. */
function legacyKind(doc, index) {
  const po = doc.findPage(index);
  const xo = po.get("Resources")?.get("XObject");
  if (xo && !xo.isNull()) {
    const ocr = xo.get("RedlineOCR");
    if (ocr && !ocr.isNull()) return "ocr";
  }
  const text = doc.loadPage(index).toStructuredText("").asText().replace(/\s+/g, "");
  return text.length >= 1 ? "text" : "none";
}

function renderOne(doc, index, zoom, mode, token) {
  if (mode === "before") {
    P.renderPage(doc, index, zoom);
    return;
  }
  P.renderTiles(doc, index, zoom, { x: 0, y: 0, w: VIEW_W, h: VIEW_H }, token);
}

export async function runMeasured(pdfPath, mode) {
  const state = { peak: process.memoryUsage().rss };
  const tOpen = performance.now();
  const bytes = fs.readFileSync(pdfPath);
  const doc = P.openBytes(bytes);
  doc.enableJournal();
  const sizes = P.pageSizes(doc);
  notePeak(state);
  const tClass = performance.now();
  const pages = sizes.length;
  for (let i = 0; i < pages; i++) {
    if (mode === "before") legacyKind(doc, i);
    else pageTextKind(doc, i);
  }
  const classMs = performance.now() - tClass;
  const openMs = performance.now() - tOpen;
  notePeak(state);

  const zoom = P.clampZoom(Math.round((VIEW_W / sizes[0].width) * 100) / 100);
  const zoom2 = P.clampZoom(Math.round(zoom * 2 * 100) / 100);
  const token = 1;

  const tFirst = performance.now();
  renderOne(doc, 0, zoom, mode, token);
  const firstMs = performance.now() - tFirst;
  notePeak(state);

  const tZoom = performance.now();
  renderOne(doc, 0, zoom2, mode, token);
  const zoomMs = performance.now() - tZoom;
  notePeak(state);

  const tScroll = performance.now();
  for (let i = 0; i < pages; i++) renderOne(doc, i, zoom, mode, token);
  const scrollMs = performance.now() - tScroll;
  notePeak(state);

  const needle = Math.abs(sizes[0].width - 612) < 2 ? "concrete" : "SHEET";
  const tSearch = performance.now();
  let hits = 0;
  for (let i = 0; i < pages; i++) {
    hits += doc.loadPage(i).search(needle, "ignore-case,ignore-diacritics").length;
  }
  const searchMs = performance.now() - tSearch;
  notePeak(state);

  const tSave = performance.now();
  const saved = P.saveBytes(doc);
  const out = path.join(os.tmpdir(), `redline-bench-save-${process.pid}.pdf`);
  fs.writeFileSync(out, saved);
  const saveMs = performance.now() - tSave;
  notePeak(state);
  try { fs.unlinkSync(out); } catch { /* temp file already gone */ }
  try { doc.destroy(); } catch { /* already gone */ }
  notePeak(state);

  process.stderr.write(
    `  ${mode} ${pages} pages open ${Math.round(openMs)}ms class ${Math.round(classMs)}ms first ${Math.round(firstMs)}ms zoom ${Math.round(zoomMs)}ms scroll ${Math.round(scrollMs)}ms search ${Math.round(searchMs)}ms hits ${hits}\n`,
  );

  return {
    pages,
    openMs: Math.round(openMs),
    classMs: Math.round(classMs),
    firstMs: Math.round(firstMs),
    scrollMs: Math.round(scrollMs),
    zoomMs: Math.round(zoomMs),
    searchMs: Math.round(searchMs),
    hits,
    saveMs: Math.round(saveMs),
    saveBytes: saved.length,
    peakRss: state.peak,
  };
}

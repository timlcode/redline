// Large-document benchmark. Generates two PDFs, then measures the previous
// full-page path and the current visible-tile path in separate processes so
// peak memory is not carried from one into the other.
//
//   npm run bench
//
// Writes bench/results.md. Fixtures stay in a temp directory.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import * as mupdf from "mupdf";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_PAGES = 300;
const DRAW_PAGES = 200;
const VIEW_W = 1100;
const VIEW_H = 800;
const SPEC_W = 612;
const SPEC_H = 792;
const DRAW_W = 24 * 72;
const DRAW_H = 36 * 72;

function pdfStr(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function specContents(i, n) {
  const lines = ["BT /F1 11 Tf"];
  lines.push(`1 0 0 1 54 760 Tm (${pdfStr(`SECTION 03 30 00  CAST-IN-PLACE CONCRETE    ${i + 1} of ${n}`)}) Tj`);
  let y = 736;
  for (let li = 0; li < 40; li++) {
    const s = `${(i % 9) + 1}.${li + 1}  Concrete shall reach the specified strength before forms are stripped, and joints shall follow the structural grid.`;
    lines.push(`1 0 0 1 54 ${y} Tm (${pdfStr(s)}) Tj`);
    y -= 16;
  }
  if (i === 149) lines.push(`1 0 0 1 54 40 Tm (${pdfStr("REDLINEBENCHTOKEN")}) Tj`);
  lines.push("ET");
  return lines.join("\n");
}

function drawContents(i, n) {
  const cmd = ["0.6 w", "0 0 0 RG"];
  cmd.push(`36 36 ${DRAW_W - 72} ${DRAW_H - 72} re S`);
  for (let x = 72; x < DRAW_W; x += 72) cmd.push(`${x} 72 m ${x} ${DRAW_H - 72} l S`);
  for (let y = 72; y < DRAW_H; y += 72) cmd.push(`72 ${y} m ${DRAW_W - 72} ${y} l S`);
  // Repeated window modules: the vector load a sheet set actually has.
  const cols = 24;
  const rows = 28;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const x = 90 + c * 68;
      const y = 160 + r * 84;
      cmd.push(`${x} ${y} 40 28 re S`);
      cmd.push(`${x} ${y + 14} m ${x + 40} ${y + 14} l S`);
      cmd.push(`${x + 20} ${y} m ${x + 20} ${y + 28} l S`);
    }
  }
  const sheet = String(i + 1).padStart(3, "0");
  cmd.push(`BT /F1 14 Tf 1 0 0 1 72 96 Tm (${pdfStr(`SHEET A-${sheet} OF ${n}`)}) Tj ET`);
  cmd.push(`BT /F1 11 Tf 1 0 0 1 360 96 Tm (${pdfStr(`FLOOR PLAN LEVEL ${(i % 12) + 1}`)}) Tj ET`);
  return cmd.join("\n");
}

function writePdf(file, pages, size, contents) {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const res = doc.addObject({ Font: { F1: font } });
  const t0 = performance.now();
  for (let i = 0; i < pages; i++) {
    doc.insertPage(i, doc.addPage([0, 0, size[0], size[1]], 0, res, contents(i, pages)));
    if ((i + 1) % 50 === 0) process.stderr.write(`  ${path.basename(file)} ${i + 1}/${pages}\n`);
  }
  const bytes = Buffer.from(doc.saveToBuffer("garbage").asUint8Array());
  fs.writeFileSync(file, bytes);
  doc.destroy();
  return { bytes: bytes.length, ms: Math.round(performance.now() - t0) };
}

function runPhase(pdf, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--phase", mode, pdf], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`bench phase ${mode} ${path.basename(pdf)} exited ${code}`));
      const line = out.trim().split("\n").pop();
      try { resolve(JSON.parse(line)); } catch (e) { reject(new Error(`bad phase output: ${line}`)); }
    });
  });
}

function fmtMs(ms) {
  if (ms >= 10000) return `${Math.round(ms / 1000)} s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

function fmtRate(pages, ms) {
  const per = ms / pages;
  const pps = pages / (ms / 1000);
  return `${pps.toFixed(2)} pages/s (${Math.round(per)} ms/page)`;
}

function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function table(specB, specA, drawB, drawA) {
  const rows = [
    ["Open", fmtMs(specB.openMs), fmtMs(specA.openMs), fmtMs(drawB.openMs), fmtMs(drawA.openMs)],
    ["Text classification (part of open)", fmtMs(specB.classMs), fmtMs(specA.classMs), fmtMs(drawB.classMs), fmtMs(drawA.classMs)],
    ["First page render", fmtMs(specB.firstMs), fmtMs(specA.firstMs), fmtMs(drawB.firstMs), fmtMs(drawA.firstMs)],
    ["Scroll / render throughput", fmtRate(specB.pages, specB.scrollMs), fmtRate(specA.pages, specA.scrollMs), fmtRate(drawB.pages, drawB.scrollMs), fmtRate(drawA.pages, drawA.scrollMs)],
    ["Zoom re-render (2× fit)", fmtMs(specB.zoomMs), fmtMs(specA.zoomMs), fmtMs(drawB.zoomMs), fmtMs(drawA.zoomMs)],
    ["Full-text search", `${fmtMs(specB.searchMs)} (${specB.hits} hits)`, `${fmtMs(specA.searchMs)} (${specA.hits} hits)`, `${fmtMs(drawB.searchMs)} (${drawB.hits} hits)`, `${fmtMs(drawA.searchMs)} (${drawA.hits} hits)`],
    ["Save", `${fmtMs(specB.saveMs)} (${mb(specB.saveBytes)})`, `${fmtMs(specA.saveMs)} (${mb(specA.saveBytes)})`, `${fmtMs(drawB.saveMs)} (${mb(drawB.saveBytes)})`, `${fmtMs(drawA.saveMs)} (${mb(drawA.saveBytes)})`],
    ["Peak RSS", mb(specB.peakRss), mb(specA.peakRss), mb(drawB.peakRss), mb(drawA.peakRss)],
  ];
  const head = "| Metric | Spec before | Spec after | Drawings before | Drawings after |";
  const sep = "| --- | ---: | ---: | ---: | ---: |";
  return [head, sep, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

function writeReport(meta, specB, specA, drawB, drawA) {
  const cpu = os.cpus()[0]?.model || "unknown";
  const body = `# Large-file benchmark

Generated by \`npm run bench\` on ${meta.when}. MuPDF ${meta.mupdf}. Node ${process.version}. ${cpu}, ${os.cpus().length} cores, ${mb(os.totalmem())} RAM.

Viewport is ${VIEW_W}×${VIEW_H} CSS pixels at fit-width (zoom rounded to 2 decimals, same rule as the viewer). Before is a full-page raster at that zoom, which is what the viewer used to request. After is the visible ${VIEW_W}×${VIEW_H} tile grid (${512} device pixels) plus a display-list cache. Each column is its own process.

Fixtures (not committed): a ${SPEC_PAGES}-page letter spec book (${mb(meta.specBytes)}, built in ${fmtMs(meta.specBuild)}) and a ${DRAW_PAGES}-sheet 24×36 drawing set (${mb(meta.drawBytes)}, built in ${fmtMs(meta.drawBuild)}, ${24 * 28} window modules per sheet). Open includes reading the file, enabling the undo journal, reading every page size, and classifying text on every page. Search is a case-insensitive scan of every page (\`concrete\` in the spec, \`SHEET\` in the drawings).

${table(specB, specA, drawB, drawA)}

## Bottlenecks

- **Full-page raster at the current zoom.** Fit-width of a 24×36 sheet is still about ${Math.round(DRAW_W * 0.64)}×${Math.round(DRAW_H * 0.64)} pixels, and zooming in rasterizes the whole sheet again. The screen only shows ${VIEW_W}×${VIEW_H}. Tile rendering draws that rectangle (and reuses the display list when the zoom changes).
- **Text classification on open.** The old check ran MuPDF structured-text extraction on every page before the first paint, including pages that already have a normal content stream. The open path now treats a \`Tj\`/\`TJ\` in the page or a form XObject as text and only falls back to a full extract for scans and odd files.
- **One document, one thread.** Rendering, search, and save all run on the server's single MuPDF document and block the event loop. Search still walks every page from scratch; a second search is not cached. Save rewrites the file (\`garbage\`) so unused objects from edits are dropped.
- **Thumbnail rail.** Page thumbnails are requested only when they scroll into view, instead of for every page at once.

## What the after column changes

- The viewer paints fixed tiles for the visible area (plus a one-tile margin) and keeps a small display-list and PNG cache keyed by the document revision.
- \`pageTextKind\` sniffs content streams before extracting structured text.
- Page and thumbnail pixmaps are destroyed after the PNG is copied out, so the full-page fallback does not wait on the garbage collector.
`;
  const out = path.join(root, "bench", "results.md");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, body);
  process.stdout.write(body);
}

async function main() {
  if (process.argv[2] === "--phase") {
    const { runMeasured } = await import("./bench-phase.mjs");
    const result = await runMeasured(process.argv[4], process.argv[3]);
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-bench-"));
  const spec = path.join(dir, "spec.pdf");
  const draw = path.join(dir, "drawings.pdf");
  process.stderr.write("Building fixtures\n");
  const specInfo = writePdf(spec, SPEC_PAGES, [SPEC_W, SPEC_H], specContents);
  const drawInfo = writePdf(draw, DRAW_PAGES, [DRAW_W, DRAW_H], drawContents);
  process.stderr.write("Measuring spec before\n");
  const specB = await runPhase(spec, "before");
  process.stderr.write("Measuring spec after\n");
  const specA = await runPhase(spec, "after");
  process.stderr.write("Measuring drawings before\n");
  const drawB = await runPhase(draw, "before");
  process.stderr.write("Measuring drawings after\n");
  const drawA = await runPhase(draw, "after");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  writeReport(
    {
      when: new Date().toISOString().slice(0, 10),
      mupdf: pkg.dependencies.mupdf,
      specBytes: specInfo.bytes,
      specBuild: specInfo.ms,
      drawBytes: drawInfo.bytes,
      drawBuild: drawInfo.ms,
    },
    specB,
    specA,
    drawB,
    drawA,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

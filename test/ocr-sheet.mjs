// Scratch: wrap the civil sheet JPG as a 36x24 in page and OCR it through the document path.
import * as mupdf from "mupdf";
import { readFileSync, writeFileSync } from "node:fs";
import * as O from "../lib/ocrdoc.mjs";

const T = process.env.TMPDIR;
const jpg = readFileSync(process.env.HOME + "/Work/lexington-bruner-sign-2026-09-28/C3.03-Bruner-Rd-entrance-setback-highlighted.jpg");
const doc = new mupdf.PDFDocument();
const im = doc.addImage(new mupdf.Image(jpg));
const res = doc.addObject({ XObject: { Im0: im } });
const W = 36 * 72, H = 24 * 72;
doc.insertPage(-1, doc.addPage([0, 0, W, H], 0, res, `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`));
writeFileSync(T + "/sheet.pdf", doc.saveToBuffer("").asUint8Array());

const d2 = mupdf.Document.openDocument(readFileSync(T + "/sheet.pdf"), "application/pdf").asPDF();
console.log("chosen dpi", O.chooseDpi(d2.loadPage(0)));
const r = await O.ocrPage(d2, 0);
console.log(`sheet: ${r.lines} lines, ${r.words} words, dpi ${r.dpi}, ${r.ms} ms`);
writeFileSync(T + "/sheet-ocr.pdf", d2.saveToBuffer("garbage").asUint8Array());
console.log("search 'setback':", O.searchPage(d2, 0, "setback").length, " 'see detail':", O.searchPage(d2, 0, "see detail").length);

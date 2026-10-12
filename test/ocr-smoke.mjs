// Scratch harness: synthetic page -> OCR. Run: node test/ocr-smoke.mjs
import * as mupdf from "mupdf";
import { Ocr } from "../lib/ocr/index.mjs";

const doc = new mupdf.PDFDocument();
const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
const res = doc.addObject({ Font: { F1: font } });
const lines = [
  "SUBMITTAL 05-120 STRUCTURAL STEEL",
  "Project: Canopy Replacement, Building 7",
  "Contractor shall verify all dimensions in field.",
  "Revision 2 dated 10/12/2026 supersedes all prior.",
  "Approved as noted: TL",
];
let cs = "BT /F1 18 Tf 72 700 Td 24 TL\n";
for (const l of lines) cs += `(${l.replace(/[()\\]/g, "\\$&")}) Tj T*\n`;
cs += "ET";
doc.insertPage(0, doc.addPage([0, 0, 612, 792], 0, res, cs));

const page = doc.loadPage(0);
const dpi = Number(process.argv[2] || 150);
const z = dpi / 72;
const pix = page.toPixmap(mupdf.Matrix.scale(z, z), mupdf.ColorSpace.DeviceRGB, false, true);
const img = { width: pix.getWidth(), height: pix.getHeight(), data: new Uint8Array(pix.getPixels()) };
console.log(`page raster ${img.width}x${img.height} (${dpi} dpi), stride ${pix.getStride()} n=${pix.getNumberOfComponents()}`);

const t0 = performance.now();
const ocr = await Ocr.load({ modelsDir: new URL("../models", import.meta.url).pathname, lang: "en" });
console.log(`load ${Math.round(performance.now() - t0)} ms`);
const t1 = performance.now();
const out = await ocr.run(img);
console.log(`run ${Math.round(performance.now() - t1)} ms  det ${Math.round(out.timing.det)}  rec ${Math.round(out.timing.rec)}`);
for (const l of out.lines) console.log(l.score.toFixed(3), JSON.stringify(l.box.map((p) => p.map(Math.round))), l.text, "|", l.words.map((w) => w.text).join("·"));

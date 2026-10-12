// Scratch harness: OCR page N of a real PDF. node test/ocr-file.mjs file.pdf [page] [dpi]
import * as mupdf from "mupdf";
import { readFileSync } from "node:fs";
import { Ocr } from "../lib/ocr/index.mjs";

const [file, pageArg = "0", dpiArg = "150"] = process.argv.slice(2);
const doc = mupdf.Document.openDocument(readFileSync(file), "application/pdf");
const page = doc.loadPage(Number(pageArg));
const b = page.getBounds();
const z = Number(dpiArg) / 72;
const pix = page.toPixmap(mupdf.Matrix.scale(z, z), mupdf.ColorSpace.DeviceRGB, false, true);
const img = { width: pix.getWidth(), height: pix.getHeight(), data: new Uint8Array(pix.getPixels()) };
console.log(`${file} page ${pageArg}: ${Math.round(b[2]-b[0])}x${Math.round(b[3]-b[1])} pt -> ${img.width}x${img.height} px @${dpiArg}dpi`);
const ocr = await Ocr.load({ modelsDir: new URL("../models", import.meta.url).pathname, lang: "en" });
const t1 = performance.now();
const out = await ocr.run(img);
console.log(`run ${Math.round(performance.now() - t1)} ms  det ${Math.round(out.timing.det)}  rec ${Math.round(out.timing.rec)}  lines ${out.lines.length}`);
for (const l of out.lines) console.log(l.score.toFixed(2), l.text);

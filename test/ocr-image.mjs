// Scratch harness: OCR a JPG/PNG. node test/ocr-image.mjs file.jpg [maxSide]
import * as mupdf from "mupdf";
import { readFileSync } from "node:fs";
import { Ocr } from "../lib/ocr/index.mjs";
const [file, maxSide = "2000"] = process.argv.slice(2);
const im = new mupdf.Image(readFileSync(file));
const pix = im.toPixmap();
let img = { width: pix.getWidth(), height: pix.getHeight(), data: new Uint8Array(pix.getPixels()) };
if (pix.getNumberOfComponents() !== 3) { // gray -> rgb
  const n = pix.getNumberOfComponents(); const d = new Uint8Array(img.width*img.height*3); const s = img.data;
  for (let i=0;i<img.width*img.height;i++){ d[i*3]=d[i*3+1]=d[i*3+2]=s[i*n]; } img.data=d;
}
console.log(`${file}: ${img.width}x${img.height}`);
const ocr = await Ocr.load({ modelsDir: new URL("../models", import.meta.url).pathname, lang: "en", maxSideLen: Number(maxSide) });
const t1 = performance.now();
const out = await ocr.run(img);
console.log(`run ${Math.round(performance.now() - t1)} ms  det ${Math.round(out.timing.det)}  rec ${Math.round(out.timing.rec)}  lines ${out.lines.length}`);
for (const l of out.lines) console.log(l.score.toFixed(2), l.text);

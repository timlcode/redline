// Redline OCR — text-line orientation classifier (0° / 180°).
import { recResize, packPadded } from "./recognize.mjs";
import { makeImage } from "./image.mjs";

export const CLS_DEFAULTS = { imgH: 48, imgW: 192, batch: 6, thresh: 0.9 };

export function rot180(img) {
  const { width: w, height: h, data } = img;
  const out = makeImage(w, h);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const s = i * 3, d = (n - 1 - i) * 3;
    out.data[d] = data[s]; out.data[d + 1] = data[s + 1]; out.data[d + 2] = data[s + 2];
  }
  return out;
}

export class TextClassifier {
  constructor(ort, session, cfg = {}) {
    this.ort = ort;
    this.session = session;
    this.cfg = { ...CLS_DEFAULTS, ...cfg };
  }

  /** Returns crops with upside-down lines rotated to upright, plus per-crop {label, score}. */
  async classify(crops) {
    const { imgH, imgW, batch, thresh } = this.cfg;
    const out = crops.slice();
    const res = new Array(crops.length);
    const plane = 3 * imgH * imgW;
    for (let beg = 0; beg < crops.length; beg += batch) {
      const end = Math.min(crops.length, beg + batch);
      const buf = new Float32Array((end - beg) * plane);
      for (let k = beg; k < end; k++) packPadded(recResize(crops[k], imgH, imgW / imgH), imgW, buf, (k - beg) * plane);
      const tensor = new this.ort.Tensor("float32", buf, [end - beg, 3, imgH, imgW]);
      const r = await this.session.run({ [this.session.inputNames[0]]: tensor });
      const o = r[this.session.outputNames[0]];
      const [B, C] = o.dims;
      for (let b = 0; b < B; b++) {
        let best = 0, bp = -Infinity;
        for (let c = 0; c < C; c++) { const v = o.data[b * C + c]; if (v > bp) { bp = v; best = c; } }
        const label = best === 1 ? "180" : "0";
        res[beg + b] = { label, score: bp };
        if (label === "180" && bp > thresh) out[beg + b] = rot180(crops[beg + b]);
      }
    }
    return { crops: out, results: res };
  }
}

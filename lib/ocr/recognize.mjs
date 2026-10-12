// Redline OCR — text recognition (CTC, PP-OCRv5 rec model).
// Input: list of upright text-line crops (RGB). Output: [{text, score, chars}] per crop.

import { resize } from "./image.mjs";

export const REC_DEFAULTS = { imgH: 48, imgW: 320, batch: 6 };

export function loadDict(text) {
  const chars = text.split(/\r?\n/);
  if (chars.length && chars[chars.length - 1] === "") chars.pop();
  chars.push(" ");
  chars.unshift("blank");
  return chars;
}

/** Resize a crop to height imgH keeping aspect, capped at width imgW = imgH*maxWhRatio. */
export function recResize(img, imgH, maxWhRatio) {
  const imgW = Math.trunc(imgH * maxWhRatio);
  const ratio = img.width / img.height;
  let rw = Math.ceil(imgH * ratio);
  if (rw > imgW) rw = imgW;
  return resize(img, rw, imgH);
}

/**
 * Pack a resized crop into a CHW float buffer of width W, normalised (x/255-0.5)/0.5, with the
 * area right of the crop left at 0 — the reference pads in normalised space, not with black.
 */
export function packPadded(img, W, out, offset = 0) {
  const { width: w, height: h, data } = img;
  const plane = W * h;
  out.fill(0, offset, offset + 3 * plane);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3, d = offset + y * W + x;
      out[d] = (data[s] / 255 - 0.5) / 0.5;
      out[d + plane] = (data[s + 1] / 255 - 0.5) / 0.5;
      out[d + 2 * plane] = (data[s + 2] / 255 - 0.5) / 0.5;
    }
  }
}

/** CTC greedy decode with duplicate collapse. Returns text, mean confidence and per-char column positions. */
export function ctcDecode(logits, T, C, dict) {
  let text = "";
  const confs = [];
  const cols = [];
  let prev = -1;
  for (let t = 0; t < T; t++) {
    let best = 0, bp = -Infinity;
    const base = t * C;
    for (let c = 0; c < C; c++) { const v = logits[base + c]; if (v > bp) { bp = v; best = c; } }
    const dup = t > 0 && best === prev;
    prev = best;
    if (dup || best === 0) continue;
    text += dict[best] ?? "";
    confs.push(bp);
    cols.push(t);
  }
  const score = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
  return { text, score, cols, T };
}

export class TextRecognizer {
  constructor(ort, session, dict, cfg = {}) {
    this.ort = ort;
    this.session = session;
    this.dict = dict;
    this.cfg = { ...REC_DEFAULTS, ...cfg };
  }

  async recognize(crops) {
    const n = crops.length;
    const results = new Array(n);
    const order = crops.map((c, i) => i).sort((a, b) => crops[a].width / crops[a].height - crops[b].width / crops[b].height);
    const { imgH, imgW, batch } = this.cfg;
    for (let beg = 0; beg < n; beg += batch) {
      const end = Math.min(n, beg + batch);
      let maxWh = imgW / imgH;
      const whs = [];
      for (let k = beg; k < end; k++) {
        const c = crops[order[k]];
        const wh = c.width / c.height;
        whs.push(wh);
        if (wh > maxWh) maxWh = wh;
      }
      const W = Math.trunc(imgH * maxWh);
      const plane = 3 * imgH * W;
      const buf = new Float32Array((end - beg) * plane);
      for (let k = beg; k < end; k++) packPadded(recResize(crops[order[k]], imgH, maxWh), W, buf, (k - beg) * plane);
      const tensor = new this.ort.Tensor("float32", buf, [end - beg, 3, imgH, W]);
      const res = await this.session.run({ [this.session.inputNames[0]]: tensor });
      const out = res[this.session.outputNames[0]];
      const [B, T, C] = out.dims;
      for (let b = 0; b < B; b++) {
        const d = ctcDecode(out.data.subarray(b * T * C, (b + 1) * T * C), T, C, this.dict);
        d.whRatio = whs[b];
        d.maxWhRatio = maxWh;
        results[order[beg + b]] = d;
      }
    }
    return results;
  }
}

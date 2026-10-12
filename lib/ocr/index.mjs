// Redline OCR — the engine. Detection + orientation + recognition. Nothing outside this
// directory and the ONNX Runtime library. Models live in <modelsDir>/ppocrv5.
//
//   const ocr = await Ocr.load({ modelsDir, lang: "en" });
//   const { lines } = await ocr.run(rgbImage);   // [{ box, text, score, words:[{text, box}] }]
//
// Large rasters (drawings) are detected in overlapping tiles so small text survives; the
// recognizer always reads crops from the full-resolution raster.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { TextDetector } from "./detect.mjs";
import { TextRecognizer, loadDict } from "./recognize.mjs";
import { TextClassifier } from "./classify.mjs";
import { rotateCropInfo, resize, makeImage } from "./image.mjs";

export const OCR_DEFAULTS = {
  lang: "en",
  textScore: 0.5,
  useCls: true,
  tileSize: 1600, // detection tile edge in pixels
  tileOverlap: 200,
  maxUntiledSide: 2000, // rasters up to this long side are detected in one pass (reference behaviour)
  minSideLen: 30,
  threads: 0, // 0 = ORT default
};

const LANG_MODELS = {
  en: { rec: "rec_en.onnx", dict: "dict_en.txt" },
  latin: { rec: "rec_latin.onnx", dict: "dict_latin.txt" },
};

export class Ocr {
  constructor(det, cls, rec, cfg) {
    this.det = det;
    this.cls = cls;
    this.rec = rec;
    this.cfg = cfg;
  }

  static async load(opts = {}) {
    const cfg = { ...OCR_DEFAULTS, ...opts };
    if (!cfg.modelsDir) throw new Error("modelsDir required");
    const ortMod = cfg.ort ?? (await import("onnxruntime-node"));
    const ort = ortMod.default?.InferenceSession ? ortMod.default : ortMod;
    const lm = LANG_MODELS[cfg.lang];
    if (!lm) throw new Error(`unknown OCR language ${cfg.lang}`);
    const dir = path.join(cfg.modelsDir, "ppocrv5");
    const so = { executionProviders: ["cpu"], graphOptimizationLevel: "all" };
    if (cfg.threads > 0) so.intraOpNumThreads = cfg.threads;
    const [detS, recS, clsS, dictTxt] = await Promise.all([
      ort.InferenceSession.create(path.join(dir, "det.onnx"), so),
      ort.InferenceSession.create(path.join(dir, lm.rec), so),
      cfg.useCls ? ort.InferenceSession.create(path.join(dir, "cls.onnx"), so) : null,
      readFile(path.join(dir, lm.dict), "utf8"),
    ]);
    const det = new TextDetector(ort, detS, cfg.det);
    const rec = new TextRecognizer(ort, recS, loadDict(dictTxt), cfg.rec);
    const cls = clsS ? new TextClassifier(ort, clsS, cfg.cls) : null;
    return new Ocr(det, cls, rec, cfg);
  }

  /** Detection over the whole raster, tiled when it is large. Boxes in raster pixels. */
  async detectAll(img) {
    const { tileSize, tileOverlap, maxUntiledSide, minSideLen } = this.cfg;
    const longSide = Math.max(img.width, img.height);
    if (longSide <= maxUntiledSide) {
      let work = img, s = 1;
      if (Math.min(img.width, img.height) < minSideLen) {
        s = minSideLen / Math.min(img.width, img.height);
        work = resize(img, Math.ceil(img.width * s), Math.ceil(img.height * s));
      }
      const r = await this.det.detect(work);
      if (s !== 1) r.boxes = r.boxes.map((b) => b.map(([x, y]) => [x / s, y / s]));
      return r;
    }
    const step = tileSize - tileOverlap;
    const all = [];
    for (let ty = 0; ty < img.height; ty += step) {
      const y0 = Math.min(ty, Math.max(0, img.height - tileSize));
      const h = Math.min(tileSize, img.height - y0);
      for (let tx = 0; tx < img.width; tx += step) {
        const x0 = Math.min(tx, Math.max(0, img.width - tileSize));
        const w = Math.min(tileSize, img.width - x0);
        const tile = crop(img, x0, y0, w, h);
        const r = await this.det.detect(tile);
        for (let i = 0; i < r.boxes.length; i++) {
          const b = r.boxes[i].map(([x, y]) => [x + x0, y + y0]);
          // drop boxes cut by an inner tile edge: the neighbouring tile sees them whole
          const touches =
            (x0 > 0 && b.some((p) => p[0] <= x0 + 2)) ||
            (y0 > 0 && b.some((p) => p[1] <= y0 + 2)) ||
            (x0 + w < img.width && b.some((p) => p[0] >= x0 + w - 2)) ||
            (y0 + h < img.height && b.some((p) => p[1] >= y0 + h - 2));
          if (touches) continue;
          all.push({ box: b, score: r.scores[i] });
        }
        if (x0 + w >= img.width) break;
      }
      if (y0 + h >= img.height) break;
    }
    const sorted = dedupe(all).sort((a, b) => a.box[0][1] - b.box[0][1]);
    let line = 0;
    const out = sorted.map((o, i) => {
      if (i > 0 && o.box[0][1] - sorted[i - 1].box[0][1] >= 10) line++;
      return { ...o, line };
    });
    out.sort((a, b) => a.line - b.line || a.box[0][0] - b.box[0][0]);
    return { boxes: out.map((o) => o.box), scores: out.map((o) => o.score) };
  }

  async run(image) {
    const t0 = performance.now();
    const det = await this.detectAll(image);
    const scores = det.scores;
    let boxes = det.boxes;
    const tDet = performance.now();
    if (!boxes.length) return { lines: [], timing: { det: tDet - t0, cls: 0, rec: 0 } };
    // Crop every line upright. A tall crop is turned 90° (counter-clockwise) to read it; the
    // box is re-ordered the same way so box[0]->box[1] stays the reading direction.
    const cropped = boxes.map((b) => rotateCropInfo(image, b));
    let crops = cropped.map((c) => c.img);
    boxes = boxes.map((b, i) => (cropped[i].rotated ? [b[1], b[2], b[3], b[0]] : b));
    let tCls = tDet;
    if (this.cls) {
      const c = await this.cls.classify(crops);
      crops = c.crops;
      boxes = boxes.map((b, i) => (c.results[i].label === "180" && c.results[i].score > this.cls.cfg.thresh ? [b[2], b[3], b[0], b[1]] : b));
      tCls = performance.now();
    }
    const recs = await this.rec.recognize(crops);
    const tRec = performance.now();
    const lines = [];
    for (let i = 0; i < boxes.length; i++) {
      const r = recs[i];
      if (!r.text.trim() || r.score < this.cfg.textScore) continue;
      lines.push({ box: boxes[i], text: r.text, score: r.score, detScore: scores[i], words: wordBoxes(boxes[i], r) });
    }
    return { lines, timing: { det: tDet - t0, cls: tCls - tDet, rec: tRec - tCls } };
  }
}

function crop(img, x0, y0, w, h) {
  const out = makeImage(w, h);
  for (let y = 0; y < h; y++) {
    const s = ((y0 + y) * img.width + x0) * 3;
    out.data.set(img.data.subarray(s, s + w * 3), y * w * 3);
  }
  return out;
}

function aabb(box) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of box) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}

/** Drop near-duplicate boxes from overlapping tiles (keep the higher score). */
function dedupe(items) {
  const rects = items.map((it) => aabb(it.box));
  const order = items.map((_, i) => i).sort((a, b) => items[b].score - items[a].score);
  const keep = [];
  const dead = new Uint8Array(items.length);
  for (const i of order) {
    if (dead[i]) continue;
    keep.push(items[i]);
    const [ax0, ay0, ax1, ay1] = rects[i];
    const aArea = (ax1 - ax0) * (ay1 - ay0);
    for (const j of order) {
      if (j === i || dead[j]) continue;
      const [bx0, by0, bx1, by1] = rects[j];
      const iw = Math.min(ax1, bx1) - Math.max(ax0, bx0), ih = Math.min(ay1, by1) - Math.max(ay0, by0);
      if (iw <= 0 || ih <= 0) continue;
      const inter = iw * ih;
      const bArea = (bx1 - bx0) * (by1 - by0);
      const iou = inter / (aArea + bArea - inter);
      const contain = inter / Math.min(aArea, bArea);
      if (iou > 0.5 || contain > 0.8) dead[j] = 1;
    }
  }
  return keep;
}

/** Split a recognised line into words with quads interpolated along the line box from CTC column positions. */
export function wordBoxes(box, r) {
  const { text, cols, T, whRatio, maxWhRatio } = r;
  if (!text) return [];
  const span = (T * whRatio) / maxWhRatio; // columns that cover the crop
  const frac = (t) => Math.min(1, Math.max(0, t / span));
  const lerp = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  const quad = (f0, f1) => [lerp(box[0], box[1], f0), lerp(box[0], box[1], f1), lerp(box[3], box[2], f1), lerp(box[3], box[2], f0)];
  const words = [];
  let cur = "", c0 = -1, cLast = -1;
  const flush = () => {
    if (!cur) return;
    words.push({ text: cur, box: quad(frac(c0 - 0.5), frac(cLast + 1.5)) });
    cur = ""; c0 = -1;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === " ") { flush(); continue; }
    if (c0 < 0) c0 = cols[i];
    cLast = cols[i];
    cur += ch;
  }
  flush();
  return words;
}

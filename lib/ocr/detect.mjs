// Redline OCR — text detection (DBNet, PP-OCRv5 det model).
// Input: RGB image. Output: text-line quads [[x,y]x4] (tl,tr,br,bl) in image pixels, with scores.

import { resize, toCHW } from "./image.mjs";

export const DET_DEFAULTS = {
  limitSideLen: 736,
  limitType: "min",
  thresh: 0.3,
  boxThresh: 0.5,
  maxCandidates: 1000,
  unclipRatio: 1.6,
  useDilation: true,
  minSize: 3,
  lineYThreshold: 10,
};

/** Resize so the limiting side is a multiple of 32 as the network requires. */
export function detResize(img, { limitSideLen, limitType }) {
  const { width: w, height: h } = img;
  let ratio = 1;
  if (limitType === "max") {
    if (Math.max(h, w) > limitSideLen) ratio = limitSideLen / Math.max(h, w);
  } else if (Math.min(h, w) < limitSideLen) {
    ratio = limitSideLen / Math.min(h, w);
  }
  let rh = Math.round((h * ratio) / 32) * 32;
  let rw = Math.round((w * ratio) / 32) * 32;
  if (rh <= 0 || rw <= 0) return null;
  return resize(img, rw, rh);
}

// ---------- geometry ----------

function convexHull(pts) {
  if (pts.length < 3) return pts.slice();
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

/** Minimum-area bounding rectangle (rotating calipers). Returns {cx, cy, w, h, angle}. */
export function minAreaRect(points) {
  const hull = convexHull(points.map((p) => [p[0], p[1]]));
  if (hull.length === 1) return { cx: hull[0][0], cy: hull[0][1], w: 0, h: 0, angle: 0 };
  if (hull.length === 2) {
    const [a, b] = hull;
    return { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, w: Math.hypot(b[0] - a[0], b[1] - a[1]), h: 0, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  }
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(ang), s = Math.sin(ang);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * c + p[1] * s;
      const v = -p[0] * s + p[1] * c;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
      best = { area, w: maxU - minU, h: maxV - minV, angle: ang, cx: cu * c - cv * s, cy: cu * s + cv * c };
    }
  }
  return best;
}

function rectPoints({ cx, cy, w, h, angle }) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const hw = w / 2, hh = h / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([u, v]) => [cx + u * c - v * s, cy + u * s + v * c]);
}

/** Order rect corners like the reference get_mini_boxes: tl, tr, br, bl by x then y. */
function miniBox(rect) {
  const pts = rectPoints(rect).sort((a, b) => a[0] - b[0]);
  let i1, i2, i3, i4;
  if (pts[1][1] > pts[0][1]) { i1 = 0; i4 = 1; } else { i1 = 1; i4 = 0; }
  if (pts[3][1] > pts[2][1]) { i2 = 2; i3 = 3; } else { i2 = 3; i3 = 2; }
  return { box: [pts[i1], pts[i2], pts[i3], pts[i4]], sside: Math.min(rect.w, rect.h) };
}

/** Mean probability inside the quad (scanline fill of a convex polygon). */
function boxScore(prob, W, H, box) {
  const xs = box.map((p) => p[0]), ys = box.map((p) => p[1]);
  const xmin = Math.max(0, Math.floor(Math.min(...xs))), xmax = Math.min(W - 1, Math.ceil(Math.max(...xs)));
  const ymin = Math.max(0, Math.floor(Math.min(...ys))), ymax = Math.min(H - 1, Math.ceil(Math.max(...ys)));
  let sum = 0, n = 0;
  for (let y = ymin; y <= ymax; y++) {
    // intersections of scanline y+0 with polygon edges
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 4; i++) {
      const [x0, y0] = box[i], [x1, y1] = box[(i + 1) % 4];
      if ((y >= Math.min(y0, y1) && y <= Math.max(y0, y1)) && y0 !== y1) {
        const x = x0 + ((y - y0) * (x1 - x0)) / (y1 - y0);
        if (x < lo) lo = x; if (x > hi) hi = x;
      } else if (y0 === y1 && y === y0) {
        lo = Math.min(lo, x0, x1); hi = Math.max(hi, x0, x1);
      }
    }
    if (lo === Infinity) continue;
    const xa = Math.max(xmin, Math.round(lo)), xb = Math.min(xmax, Math.round(hi));
    for (let x = xa; x <= xb; x++) { sum += prob[y * W + x]; n++; }
  }
  return n ? sum / n : 0;
}

/** Expand a rectangle by the DB unclip distance (area*ratio/perimeter), as pyclipper round-offset + minAreaRect would. */
function unclip(rect, ratio) {
  const area = rect.w * rect.h, perim = 2 * (rect.w + rect.h);
  if (perim === 0) return rect;
  const d = (area * ratio) / perim;
  return { ...rect, w: rect.w + 2 * d, h: rect.h + 2 * d };
}

// ---------- connected components ----------

/** Label 8-connected components of a binary mask. Returns array of boundary-pixel point lists. */
function components(mask, W, H, maxCount) {
  const labels = new Int32Array(W * H);
  const out = [];
  const stack = new Int32Array(W * H);
  let next = 1;
  for (let start = 0; start < W * H; start++) {
    if (!mask[start] || labels[start]) continue;
    if (out.length >= maxCount) break;
    const pts = [];
    let sp = 0;
    stack[sp++] = start;
    labels[start] = next;
    while (sp) {
      const idx = stack[--sp];
      const x = idx % W, y = (idx - x) / W;
      // boundary pixel if any 4-neighbour is background/edge
      let boundary = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      if (!boundary) boundary = !mask[idx - 1] || !mask[idx + 1] || !mask[idx - W] || !mask[idx + W];
      if (boundary) pts.push([x, y]);
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx; if (nx < 0 || nx >= W) continue;
          const n = ny * W + nx;
          if (mask[n] && !labels[n]) { labels[n] = next; stack[sp++] = n; }
        }
      }
    }
    out.push(pts);
    next++;
  }
  return out;
}

function dilate2x2(mask, W, H) {
  // cv2.dilate with an all-ones 2x2 kernel (anchor at centre = (0,0) for even kernels): out(x,y) = any of (x,y),(x+1,y),(x,y+1),(x+1,y+1)
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let v = mask[i];
      if (!v && x + 1 < W) v = mask[i + 1];
      if (!v && y + 1 < H) v = mask[i + W];
      if (!v && x + 1 < W && y + 1 < H) v = mask[i + W + 1];
      out[i] = v;
    }
  }
  return out;
}

/** imutils-style clockwise ordering: tl, tr, br, bl. */
export function orderClockwise(pts) {
  const xs = pts.slice().sort((a, b) => a[0] - b[0]);
  const left = xs.slice(0, 2).sort((a, b) => a[1] - b[1]);
  const right = xs.slice(2).sort((a, b) => a[1] - b[1]);
  return [left[0], right[0], right[1], left[1]];
}

/** DB post-process: probability map -> boxes in original image coordinates. */
export function dbPostProcess(prob, W, H, srcW, srcH, cfg) {
  let mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) mask[i] = prob[i] > cfg.thresh ? 1 : 0;
  if (cfg.useDilation) mask = dilate2x2(mask, W, H);
  const comps = components(mask, W, H, cfg.maxCandidates);
  const boxes = [], scores = [];
  for (const pts of comps) {
    if (!pts.length) continue;
    const rect = minAreaRect(pts);
    const { box, sside } = miniBox(rect);
    if (sside < cfg.minSize) continue;
    const score = boxScore(prob, W, H, box);
    if (score < cfg.boxThresh) continue;
    const big = unclip(rect, cfg.unclipRatio);
    const m2 = miniBox(big);
    if (m2.sside < cfg.minSize + 2) continue;
    const scaled = m2.box.map(([x, y]) => [
      Math.min(srcW, Math.max(0, Math.round((x / W) * srcW))),
      Math.min(srcH, Math.max(0, Math.round((y / H) * srcH))),
    ]);
    boxes.push(scaled);
    scores.push(score);
  }
  // filter_det_res
  const outB = [], outS = [];
  for (let i = 0; i < boxes.length; i++) {
    let b = orderClockwise(boxes[i]).map(([x, y]) => [
      Math.min(srcW - 1, Math.max(0, Math.trunc(x))),
      Math.min(srcH - 1, Math.max(0, Math.trunc(y))),
    ]);
    const rw = Math.trunc(Math.hypot(b[0][0] - b[1][0], b[0][1] - b[1][1]));
    const rh = Math.trunc(Math.hypot(b[0][0] - b[3][0], b[0][1] - b[3][1]));
    if (rw <= 3 || rh <= 3) continue;
    outB.push(b); outS.push(scores[i]);
  }
  return { boxes: outB, scores: outS };
}

/** Reading order: top-to-bottom, then left-to-right within a line band. */
export function sortBoxes(boxes, scores, yThreshold = DET_DEFAULTS.lineYThreshold) {
  const idx = boxes.map((_, i) => i).sort((a, b) => boxes[a][0][1] - boxes[b][0][1]);
  const lineIds = new Array(idx.length).fill(0);
  for (let k = 1; k < idx.length; k++) {
    const dy = boxes[idx[k]][0][1] - boxes[idx[k - 1]][0][1];
    lineIds[k] = lineIds[k - 1] + (dy >= yThreshold ? 1 : 0);
  }
  const order = idx.map((i, k) => ({ i, line: lineIds[k], x: boxes[i][0][0] }))
    .sort((a, b) => a.line - b.line || a.x - b.x);
  return { boxes: order.map((o) => boxes[o.i]), scores: order.map((o) => scores[o.i]) };
}

export class TextDetector {
  constructor(ort, session, cfg = {}) {
    this.ort = ort;
    this.session = session;
    this.cfg = { ...DET_DEFAULTS, ...cfg };
  }

  async detect(img) {
    const rs = detResize(img, this.cfg);
    if (!rs) return { boxes: [], scores: [] };
    const input = new Float32Array(3 * rs.width * rs.height);
    toCHW(rs, input);
    const tensor = new this.ort.Tensor("float32", input, [1, 3, rs.height, rs.width]);
    const res = await this.session.run({ [this.session.inputNames[0]]: tensor });
    const out = res[this.session.outputNames[0]];
    const [, , H, W] = out.dims;
    const prob = out.data;
    const { boxes, scores } = dbPostProcess(prob, W, H, img.width, img.height, this.cfg);
    return sortBoxes(boxes, scores, this.cfg.lineYThreshold);
  }
}

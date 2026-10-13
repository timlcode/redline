// Shrink embedded images that are drawn larger, in pixels, than a target dpi.
// Text, vectors, and form fields are left alone. Images with a soft mask are
// skipped so a transparent stamp does not turn into a solid box.
import * as mupdf from "mupdf";
import { httpError, saveBytes } from "./pdf.mjs";

const IDENTITY = [1, 0, 0, 1, 0, 0];

const ARITY = {
  q: 0, Q: 0, S: 0, s: 0, f: 0, F: 0, "f*": 0, n: 0, W: 0, "W*": 0, h: 0,
  b: 0, "b*": 0, B: 0, "B*": 0, BT: 0, ET: 0, "T*": 0, EMC: 0,
  Do: 1, Tj: 1, "'": 1, gs: 1, ri: 1, CS: 1, cs: 1, G: 1, g: 1, j: 1, J: 1,
  w: 1, M: 1, Tc: 1, Tw: 1, Tz: 1, TL: 1, Tr: 1, Ts: 1, i: 1, sh: 1, BMC: 1, MP: 1,
  Td: 2, TD: 2, Tf: 2, m: 2, l: 2, d: 2, sc: 2, SC: 2, d0: 2, d1: 2, BDC: 2, DP: 2,
  rg: 3, RG: 3, "\"": 3,
  re: 4, v: 4, y: 4, k: 4, K: 4,
  cm: 6, Tm: 6, c: 6,
  TJ: 1,
};

export function normalizeCompress(input = {}) {
  const dpi = Number(input.dpi ?? 150);
  const quality = Number(input.quality ?? 70);
  if (!Number.isFinite(dpi) || dpi < 36 || dpi > 600) throw httpError(400, "DPI must be between 36 and 600");
  if (!Number.isFinite(quality) || quality < 30 || quality > 95) throw httpError(400, "Quality must be between 30 and 95");
  return { dpi, quality: Math.round(quality), grayscale: !!input.grayscale };
}

function tokenize(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString("latin1") : Buffer.from(buf).toString("latin1");
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\0") { i++; continue; }
    if (c === "%") {
      while (i < n && s[i] !== "\n" && s[i] !== "\r") i++;
      continue;
    }
    if (c === "(") {
      let depth = 1;
      i++;
      while (i < n && depth) {
        if (s[i] === "\\") { i += 2; continue; }
        if (s[i] === "(") depth++;
        else if (s[i] === ")") { depth--; if (!depth) { i++; break; } }
        i++;
      }
      out.push({ t: "str" });
      continue;
    }
    if (c === "<" && s[i + 1] === "<") { out.push({ t: "op", v: "<<" }); i += 2; continue; }
    if (c === ">" && s[i + 1] === ">") { out.push({ t: "op", v: ">>" }); i += 2; continue; }
    if (c === "<") {
      i++;
      while (i < n && s[i] !== ">") i++;
      i++;
      out.push({ t: "hex" });
      continue;
    }
    if (c === "/") {
      i++;
      let name = "";
      while (i < n && !" \t\r\n\f\0[]{}()/<>%".includes(s[i])) name += s[i++];
      out.push({ t: "name", v: name });
      continue;
    }
    if (c === "[" || c === "]") { out.push({ t: "op", v: c }); i++; continue; }
    if ("+-0123456789.".includes(c)) {
      let j = i + 1;
      while (j < n && "0123456789.+-eE".includes(s[j])) j++;
      const num = s.slice(i, j);
      if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(num)) {
        out.push({ t: "num", v: Number(num) });
        i = j;
        continue;
      }
    }
    let j = i;
    while (j < n && !" \t\r\n\f\0[]{}()/<>%".includes(s[j])) j++;
    const word = s.slice(i, j);
    if (word === "BI") break;
    out.push({ t: "op", v: word });
    i = j;
  }
  return out;
}

function collapse(tokens) {
  const root = [];
  const stack = [root];
  for (const tok of tokens) {
    if (tok.t === "op" && tok.v === "[") {
      const arr = [];
      stack.at(-1).push({ t: "arr", v: arr });
      stack.push(arr);
    } else if (tok.t === "op" && tok.v === "]") {
      if (stack.length > 1) stack.pop();
    } else if (tok.t === "op" && tok.v === "<<") {
      const dict = [];
      stack.at(-1).push({ t: "dict", v: dict });
      stack.push(dict);
    } else if (tok.t === "op" && tok.v === ">>") {
      if (stack.length > 1) stack.pop();
    } else {
      stack.at(-1).push(tok);
    }
  }
  return root;
}

function multiply(m, n) {
  const [a1, b1, c1, d1, e1, f1] = m;
  const [a2, b2, c2, d2, e2, f2] = n;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function contentBuffers(contents) {
  if (!contents || contents.isNull()) return [];
  if (contents.isArray()) {
    const parts = [];
    for (let i = 0; i < contents.length; i++) {
      const item = contents.get(i);
      try {
        if (item && item.isStream()) parts.push(Buffer.from(item.readStream().asUint8Array()));
      } catch {
        /* unreadable stream */
      }
    }
    return parts;
  }
  try {
    if (contents.isStream()) return [Buffer.from(contents.readStream().asUint8Array())];
  } catch {
    /* unreadable */
  }
  return [];
}

function isName(obj, expected) {
  try { return obj && !obj.isNull() && obj.isName() && obj.asName() === expected; } catch { return false; }
}

function matrixOf(obj) {
  try {
    if (obj && !obj.isNull() && obj.isArray() && obj.length >= 6) {
      return [0, 1, 2, 3, 4, 5].map((i) => obj.get(i).asNumber());
    }
  } catch {
    /* identity */
  }
  return IDENTITY;
}

function noteImage(hits, xo, ctm) {
  if (!xo || xo.isNull()) return;
  let num = 0;
  try { num = xo.asIndirect(); } catch { num = 0; }
  if (!num) return;
  const dw = Math.hypot(ctm[0], ctm[1]);
  const dh = Math.hypot(ctm[2], ctm[3]);
  if (!(dw >= 1 && dh >= 1)) return;
  const prev = hits.get(num);
  if (!prev) hits.set(num, { obj: xo, dw, dh });
  else {
    prev.dw = Math.max(prev.dw, dw);
    prev.dh = Math.max(prev.dh, dh);
  }
}

function walkStream(doc, resources, bytes, ctm, hits, seen) {
  const tokens = collapse(tokenize(bytes));
  const stack = [];
  const saved = [];
  let cur = ctm;
  for (const tok of tokens) {
    if (tok.t !== "op") {
      stack.push(tok);
      continue;
    }
    const op = tok.v;
    if (op === "q") {
      saved.push(cur);
      continue;
    }
    if (op === "Q") {
      cur = saved.pop() || cur;
      continue;
    }
    if (op === "cm") {
      const nums = [];
      for (let k = 0; k < 6; k++) {
        const item = stack.pop();
        nums.push(item && item.t === "num" ? item.v : 0);
      }
      const [f, e, d, c, b, a] = nums;
      cur = multiply(cur, [a, b, c, d, e, f]);
      continue;
    }
    if (op === "Do") {
      const name = stack.pop();
      if (!name || name.t !== "name" || !resources) continue;
      let xo;
      try { xo = resources.get("XObject", name.v); } catch { xo = null; }
      if (!xo || xo.isNull()) continue;
      if (isName(xo.get("Subtype"), "Form")) {
        let id = 0;
        try { id = xo.asIndirect(); } catch { id = 0; }
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        const child = xo.get("Resources");
        const res = child && !child.isNull() ? child : resources;
        const next = multiply(cur, matrixOf(xo.get("Matrix")));
        for (const part of contentBuffers(xo)) walkStream(doc, res, part, next, hits, seen);
        continue;
      }
      if (isName(xo.get("Subtype"), "Image")) noteImage(hits, xo, cur);
      continue;
    }
    const n = ARITY[op];
    if (n) {
      for (let k = 0; k < n && stack.length; k++) stack.pop();
    }
  }
}

function collectImages(doc) {
  const hits = new Map();
  const seen = new Set();
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    const obj = page.getObject();
    let resources = obj.get("Resources");
    if (!resources || resources.isNull()) {
      try { resources = obj.getInheritable("Resources"); } catch { resources = null; }
    }
    const parts = contentBuffers(obj.get("Contents"));
    let ctm = IDENTITY;
    for (const part of parts) walkStream(doc, resources, part, ctm, hits, seen);
  }
  return hits;
}

function componentCount(pix) {
  return pix.getNumberOfComponents() + (pix.getAlpha() ? 1 : 0);
}

function resample(src, nw, nh) {
  const sw = src.getWidth();
  const sh = src.getHeight();
  const n = componentCount(src);
  const colorN = src.getNumberOfComponents();
  const out = new mupdf.Pixmap(src.getColorSpace(), [0, 0, nw, nh], !!src.getAlpha());
  const s = src.getPixels();
  const d = out.getPixels();
  const dn = componentCount(out);
  for (let y = 0; y < nh; y++) {
    const fy = (y + 0.5) * sh / nh - 0.5;
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = Math.min(1, Math.max(0, fy - y0));
    for (let x = 0; x < nw; x++) {
      const fx = (x + 0.5) * sw / nw - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = Math.min(1, Math.max(0, fx - x0));
      const di = (y * nw + x) * dn;
      for (let c = 0; c < n; c++) {
        const i00 = (y0 * sw + x0) * n + c;
        const i10 = (y0 * sw + x1) * n + c;
        const i01 = (y1 * sw + x0) * n + c;
        const i11 = (y1 * sw + x1) * n + c;
        const v = s[i00] * (1 - tx) * (1 - ty) + s[i10] * tx * (1 - ty) + s[i01] * (1 - tx) * ty + s[i11] * tx * ty;
        d[di + c] = Math.round(v);
      }
    }
  }
  void colorN;
  return out;
}

function skipImage(xo) {
  try {
    const mask = xo.get("SMask");
    if (mask && !mask.isNull()) return true;
  } catch { /* no mask */ }
  try {
    const im = xo.get("ImageMask");
    if (im && im.isBoolean && im.isBoolean() && im.asBoolean()) return true;
  } catch { /* not a mask */ }
  try {
    const bpc = xo.get("BitsPerComponent");
    if (bpc && bpc.isNumber && bpc.isNumber() && bpc.asNumber() < 8) return true;
  } catch { /* unknown */ }
  return false;
}

function replaceImage(xo, pix, quality) {
  const jpeg = pix.asJPEG(quality, false);
  const gray = pix.getNumberOfComponents() === 1;
  xo.put("Width", pix.getWidth());
  xo.put("Height", pix.getHeight());
  xo.put("ColorSpace", gray ? "DeviceGray" : "DeviceRGB");
  xo.put("BitsPerComponent", 8);
  xo.put("Filter", "DCTDecode");
  xo.delete("DecodeParms");
  xo.delete("SMask");
  xo.delete("Mask");
  xo.delete("Decode");
  xo.writeStream(jpeg);
}

/**
 * Downsample images above `dpi` when drawn. Returns byte sizes from a full
 * save (`garbage`), which is the size a Save would write.
 * Does not change the file when no image needs work.
 */
export function compressDocument(doc, input = {}) {
  const opts = normalizeCompress(input);
  const before = saveBytes(doc).length;
  const hits = collectImages(doc);
  let imagesChanged = 0;
  let skipped = 0;
  for (const { obj, dw, dh } of hits.values()) {
    if (skipImage(obj)) { skipped++; continue; }
    let image;
    try { image = doc.loadImage(obj); } catch { skipped++; continue; }
    const dpiX = image.getWidth() * 72 / dw;
    const dpiY = image.getHeight() * 72 / dh;
    const oversized = dpiX > opts.dpi + 0.5 || dpiY > opts.dpi + 0.5;
    if (!oversized && !opts.grayscale) continue;
    let nw = image.getWidth();
    let nh = image.getHeight();
    if (oversized) {
      nw = Math.max(1, Math.round(dw / 72 * opts.dpi));
      nh = Math.max(1, Math.round(dh / 72 * opts.dpi));
      nw = Math.min(nw, image.getWidth());
      nh = Math.min(nh, image.getHeight());
    }
    let pix = image.toPixmap();
    try {
      if (nw !== pix.getWidth() || nh !== pix.getHeight()) {
        const scaled = resample(pix, nw, nh);
        pix.destroy();
        pix = scaled;
      }
      if (opts.grayscale && pix.getColorSpace() !== mupdf.ColorSpace.DeviceGray) {
        const gray = pix.convertToColorSpace(mupdf.ColorSpace.DeviceGray, false);
        pix.destroy();
        pix = gray;
      } else if (pix.getNumberOfComponents() !== 1 && pix.getNumberOfComponents() !== 3) {
        const rgb = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
        pix.destroy();
        pix = rgb;
      } else if (pix.getAlpha()) {
        const flat = pix.convertToColorSpace(pix.getColorSpace(), false);
        pix.destroy();
        pix = flat;
      }
      replaceImage(obj, pix, opts.quality);
      imagesChanged++;
    } catch {
      skipped++;
    } finally {
      try { pix.destroy(); } catch { /* already dropped */ }
    }
  }
  const after = imagesChanged ? saveBytes(doc).length : before;
  return {
    before,
    after,
    images: hits.size,
    imagesChanged,
    skipped,
    dpi: opts.dpi,
    quality: opts.quality,
    grayscale: opts.grayscale,
  };
}

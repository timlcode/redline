// Redline — invisible OCR text layer.
// Writes recognised words into the page as PDF text with render mode 3 (no fill, no stroke) so
// the pixels are untouched but Find, select and copy work in any viewer. Everything lives in one
// Form XObject per page named /RedlineOCR; running OCR again replaces it.

import * as mupdf from "mupdf";
import { imageToUserMatrix } from "./pdf.mjs";

export const OCR_XOBJECT = "RedlineOCR";
const FONT_NAME = "RLOCR";
// Nimbus Sans / Helvetica vertical metrics as a fraction of the em: ascender ~0.95, descender ~0.21
const ASCENT = 0.95;
const DESCENT = 0.21;

export function pageTextLength(doc, index) {
  const page = doc.loadPage(index);
  return page.toStructuredText("").asText().replace(/\s+/g, "").length;
}

const TEXT_OP = /\([^\\)\s][^)]{0,240}\)\s*Tj|\[[^\]]{0,480}\]\s*TJ/;

function isImageStream(obj) {
  try {
    const sub = obj.get("Subtype");
    if (!sub || sub.isNull() || !sub.isName()) return false;
    const name = sub.asName();
    return name === "Image" || name === "/Image";
  } catch {
    return false;
  }
}

function streamHasText(obj) {
  if (!obj || obj.isNull()) return false;
  if (obj.isArray()) {
    for (let i = 0; i < obj.length; i++) if (streamHasText(obj.get(i))) return true;
    return false;
  }
  if (!obj.isStream() || isImageStream(obj)) return false;
  const raw = Buffer.from(obj.readStream().asUint8Array()).toString("latin1");
  return TEXT_OP.test(raw);
}

/**
 * Cheap "this page already has text" check: look for Tj/TJ in the page content
 * and in form XObjects. Misses are corrected by the full text extract below.
 * Image XObjects are not decoded.
 */
function pageStreamsHaveText(po) {
  if (streamHasText(po.get("Contents"))) return true;
  const xobj = po.get("Resources")?.get("XObject");
  if (!xobj || xobj.isNull() || !xobj.isDictionary()) return false;
  let found = false;
  xobj.forEach((val) => {
    if (found || isImageStream(val)) return;
    let form = false;
    try {
      const sub = val.get("Subtype");
      const name = sub && !sub.isNull() && sub.isName() ? sub.asName() : "";
      form = name === "Form" || name === "/Form";
    } catch { form = false; }
    if (form && streamHasText(val)) found = true;
  });
  return found;
}

/** "none" (image only), "ocr" (Redline layer present), or "text" (native text). */
export function pageTextKind(doc, index) {
  const po = doc.findPage(index);
  const xo = po.get("Resources")?.get("XObject");
  if (xo && !xo.isNull() && xo.get(OCR_XOBJECT) && !xo.get(OCR_XOBJECT).isNull()) return "ocr";
  try {
    if (pageStreamsHaveText(po)) return "text";
  } catch { /* fall through to a real extract */ }
  // Any real text at all means "not a scan" (Acrobat refuses to OCR such pages too).
  return pageTextLength(doc, index) >= 1 ? "text" : "none";
}

// A fresh (tiny, non-embedded) Helvetica font object per layer: nothing to go stale across undo.
function layerFont(doc) {
  const fz = new mupdf.Font("Helvetica");
  return { fz, ref: doc.addSimpleFont(fz, "Latin") };
}

/** WinAnsi bytes for a string, with a PDF-literal escape. Unencodable characters become '?'. */
export function encodeLatin(text) {
  let out = "";
  for (const ch of text) {
    let cp = ch.codePointAt(0);
    if (cp === 0x2019 || cp === 0x2018) cp = 0x27;
    else if (cp === 0x201c || cp === 0x201d) cp = 0x22;
    else if (cp === 0x2013 || cp === 0x2014 || cp === 0x2212) cp = 0x2d;
    else if (cp === 0x2022) cp = 0xb7;
    if (cp < 32 || (cp > 126 && cp < 160) || cp > 255) cp = 0x3f;
    const c = String.fromCharCode(cp);
    out += c === "(" || c === ")" || c === "\\" ? "\\" + c : c;
  }
  return out;
}

function textWidth(fz, text) {
  let w = 0;
  for (const ch of text) {
    let cp = ch.codePointAt(0);
    if (cp > 255) cp = 0x3f;
    w += fz.advanceGlyph(fz.encodeCharacter(cp), 0);
  }
  return w;
}

/**
 * Build the content of the OCR form for a page.
 * words: [{text, box:[[x,y]x4] in raster pixels (tl,tr,br,bl)}], zoom: raster pixels per PDF point.
 */
export function buildLayerContent(page, fz, lines, zoom) {
  const m = imageToUserMatrix(page, zoom);
  const tp = ([x, y]) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
  let cs = "BT\n3 Tr\n";
  for (const line of lines) {
    const items = line.words && line.words.length ? line.words : [{ text: line.text, box: line.box }];
    for (const w of items) {
      const text = w.text.trim();
      if (!text) continue;
      const [tl, tr, br, bl] = w.box.map(tp);
      // baseline direction and the box's vertical extent
      let dx = br[0] - bl[0], dy = br[1] - bl[1];
      const width = Math.hypot(dx, dy);
      if (width < 0.01) continue;
      dx /= width; dy /= width;
      const height = Math.hypot(tl[0] - bl[0], tl[1] - bl[1]);
      if (height < 0.01) continue;
      const size = height / (ASCENT + DESCENT);
      // up vector = baseline rotated 90° towards the top edge
      let ux = -dy, uy = dx;
      if (ux * (tl[0] - bl[0]) + uy * (tl[1] - bl[1]) < 0) { ux = -ux; uy = -uy; }
      const ox = bl[0] + ux * DESCENT * size, oy = bl[1] + uy * DESCENT * size;
      const natural = textWidth(fz, text) * size;
      const tz = natural > 0 ? (width / natural) * 100 : 100;
      const f = (n) => (Math.round(n * 1000) / 1000).toString();
      cs += `/${FONT_NAME} ${f(size)} Tf ${f(tz)} Tz ${f(dx)} ${f(dy)} ${f(ux)} ${f(uy)} ${f(ox)} ${f(oy)} Tm (${encodeLatin(text)}) Tj\n`;
    }
  }
  cs += "ET\n";
  return cs;
}

/** Install (or replace) the OCR layer of a page. Returns the number of words written. */
export function writeTextLayer(doc, index, lines, zoom) {
  const page = doc.loadPage(index);
  const po = doc.findPage(index);
  const { fz, ref: fontRef } = layerFont(doc);
  const content = buildLayerContent(page, fz, lines, zoom);
  const bbox = po.get("MediaBox");
  const mb = bbox && !bbox.isNull() ? [0, 1, 2, 3].map((i) => bbox.get(i).asNumber()) : [0, 0, 612, 792];
  const formDict = doc.newDictionary();
  formDict.put("Type", doc.newName("XObject"));
  formDict.put("Subtype", doc.newName("Form"));
  formDict.put("BBox", mbArray(doc, mb));
  const fontDict = doc.newDictionary();
  fontDict.put(FONT_NAME, fontRef);
  const resDict = doc.newDictionary();
  resDict.put("Font", fontDict);
  formDict.put("Resources", resDict);
  const form = doc.addStream(Buffer.from(content, "latin1"), formDict); // WinAnsi bytes, not UTF-8

  // resources
  let res = po.get("Resources");
  if (!res || res.isNull()) { res = doc.newDictionary(); po.put("Resources", res); }
  let xo = res.get("XObject");
  if (!xo || xo.isNull()) { xo = doc.newDictionary(); res.put("XObject", xo); }
  const had = xo.get(OCR_XOBJECT) && !xo.get(OCR_XOBJECT).isNull();
  xo.put(OCR_XOBJECT, form);

  if (!had) {
    // Wrap the existing content in q/Q so a stray state change cannot move the layer, then draw it.
    const head = doc.addStream("q\n", doc.newDictionary());
    const tail = doc.addStream(`Q\nq /${OCR_XOBJECT} Do Q\n`, doc.newDictionary());
    const contents = po.get("Contents");
    const arr = doc.newArray();
    arr.push(head);
    if (contents && !contents.isNull()) {
      if (contents.isArray()) for (let i = 0; i < contents.length; i++) arr.push(contents.get(i));
      else arr.push(contents);
    }
    arr.push(tail);
    po.put("Contents", arr);
  }
  return content.split("\n").filter((l) => l.endsWith("Tj")).length;
}

function mbArray(doc, mb) {
  const a = doc.newArray();
  for (const n of mb) a.push(n);
  return a;
}

/** Remove the Redline OCR layer from a page (keeps the q/Q wrapper; the Do becomes a no-op). */
export function removeTextLayer(doc, index) {
  const po = doc.findPage(index);
  const xo = po.get("Resources")?.get("XObject");
  if (!xo || xo.isNull() || !xo.get(OCR_XOBJECT) || xo.get(OCR_XOBJECT).isNull()) return false;
  xo.put(OCR_XOBJECT, emptyForm(doc, po));
  return true;
}

function emptyForm(doc, po) {
  const bbox = po.get("MediaBox");
  const mb = bbox && !bbox.isNull() ? [0, 1, 2, 3].map((i) => bbox.get(i).asNumber()) : [0, 0, 612, 792];
  const d = doc.newDictionary();
  d.put("Type", doc.newName("XObject"));
  d.put("Subtype", doc.newName("Form"));
  d.put("BBox", mbArray(doc, mb));
  return doc.addStream("", d);
}

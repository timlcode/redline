// True redaction. Marks are Redact annotations the user can review. Applying
// them deletes the underlying text, vectors, and image pixels, then writes a
// fresh file (never an incremental save). Sanitize drops hidden information.
import zlib from "node:zlib";
import * as mupdf from "mupdf";
import {
  clampZoom,
  httpError,
  imagePointToUser,
  parseColor,
  userPointToPage,
  userRectToPage,
  imageRectToUser,
  textMap,
} from "./pdf.mjs";

const OVERLAY_MAX = 40;
const SEARCH_CAP = 500;
const COMMENT_TYPES = new Set(["Text", "Popup", "Highlight", "Underline", "StrikeOut", "Squiggly", "Caret"]);

const PATTERNS = {
  phone: /(?:\+?1[\s.-])?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/gi,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  money: /\$\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?\b/g,
};

export const PATTERN_NAMES = Object.keys(PATTERNS);

function num(n) {
  return (Math.round(Number(n) * 1000) / 1000).toString();
}

function round4(n) {
  return Math.round(n * 100) / 100;
}

function mapPoint(pt, m) {
  return [pt[0] * m[0] + pt[1] * m[2] + m[4], pt[0] * m[1] + pt[1] * m[3] + m[5]];
}

function mapRect(rect, m) {
  const pts = [
    [rect[0], rect[1]],
    [rect[2], rect[1]],
    [rect[0], rect[3]],
    [rect[2], rect[3]],
  ].map((p) => mapPoint(p, m));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function pageRectToUser(page, rect) {
  return mapRect(rect, mupdf.Matrix.invert(page.getTransform()));
}

function overlaps(a, b) {
  return a[0] < b[2] - 0.4 && a[2] > b[0] + 0.4 && a[1] < b[3] - 0.4 && a[3] > b[1] + 0.4;
}

function pointIn(x, y, r) {
  return x >= r[0] - 0.5 && x <= r[2] + 0.5 && y >= r[1] - 0.5 && y <= r[3] + 0.5;
}

function quadBounds(q) {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function checkPage(doc, index) {
  const n = doc.countPages();
  if (!Number.isInteger(index) || index < 0 || index >= n) throw httpError(400, `No page ${index}`);
}

function latin(text) {
  let out = "";
  for (const ch of String(text)) {
    let cp = ch.codePointAt(0);
    if (cp === 0x2019 || cp === 0x2018) cp = 0x27;
    else if (cp === 0x201c || cp === 0x201d) cp = 0x22;
    else if (cp === 0x2013 || cp === 0x2014) cp = 0x2d;
    if (cp < 32 || (cp > 126 && cp < 160) || cp > 255) cp = 0x3f;
    const c = String.fromCharCode(cp);
    out += c === "(" || c === ")" || c === "\\" ? "\\" + c : c;
  }
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function colorOf(input) {
  const c = parseColor(input === undefined || input === "" ? "black" : input, "black");
  return c.map((v) => Math.min(1, Math.max(0, v)));
}

function overlayText(input) {
  return String(input ?? "").replace(/\s+/g, " ").trim().slice(0, OVERLAY_MAX);
}

function annotId(a) {
  const n = a.getObject().asIndirect();
  return Number.isInteger(n) ? n : 0;
}

function readColor(annot) {
  try {
    const ic = annot.getObject().get("IC");
    if (ic && !ic.isNull() && ic.isArray() && ic.length >= 3) {
      return [0, 1, 2].map((i) => ic.get(i).asNumber());
    }
  } catch { /* default */ }
  return [0, 0, 0];
}

function readOverlay(annot) {
  try {
    const t = annot.getObject().get("OverlayText");
    if (t && !t.isNull() && t.isString()) return t.asString();
  } catch { /* none */ }
  return "";
}

function readLabel(annot) {
  try { return annot.getContents() || ""; } catch { return ""; }
}

const fontRefs = new WeakMap();
function overlayFont(doc) {
  let ref = fontRefs.get(doc);
  if (!ref) {
    ref = doc.addSimpleFont(new mupdf.Font("Helvetica-Bold"), "Latin");
    fontRefs.set(doc, ref);
  }
  return ref;
}

function contrast(color) {
  const y = color[0] * 0.3 + color[1] * 0.59 + color[2] * 0.11;
  return y > 0.62 ? [0, 0, 0] : [1, 1, 1];
}

/** Preview appearance so a mark is visible before it is applied. */
function paintAppearance(doc, annot, color, overlay) {
  const r = annot.getRect();
  const w = Math.max(1, r[2] - r[0]);
  const h = Math.max(1, r[3] - r[1]);
  let cs = `q ${num(color[0])} ${num(color[1])} ${num(color[2])} rg 0 0 ${num(w)} ${num(h)} re f Q\n`;
  const resources = {};
  const text = overlayText(overlay);
  if (text) {
    const ink = contrast(color);
    let size = Math.min(11, Math.max(4, h * 0.62));
    const widthAt = (s) => text.length * s * 0.52;
    while (size > 4 && widthAt(size) > w - 4) size -= 0.5;
    if (widthAt(size) <= w - 2) {
      resources.Font = { RdOv: overlayFont(doc) };
      const tw = widthAt(size);
      const tx = (w - tw) / 2;
      const ty = Math.max(1, (h - size * 0.72) / 2);
      cs += `BT /RdOv ${num(size)} Tf ${ink.map(num).join(" ")} rg 1 0 0 1 ${num(tx)} ${num(ty)} Tm (${latin(text)}) Tj ET\n`;
    }
  }
  annot.setAppearance("N", null, mupdf.Matrix.identity, [0, 0, w, h], resources, Buffer.from(cs, "latin1"));
}

function imageQuadToPage(page, zoom, q) {
  const out = [];
  for (let i = 0; i < 8; i += 2) {
    const user = imagePointToUser(page, zoom, [q[i], q[i + 1]]);
    const pg = userPointToPage(page, user);
    out.push(pg[0], pg[1]);
  }
  return out;
}

function eachRedact(doc, fn) {
  const out = [];
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    for (const annot of page.getAnnotations()) {
      if (annot.getType() !== "Redact") continue;
      out.push(fn(annot, page, i));
    }
  }
  return out;
}

export function listMarks(doc) {
  return eachRedact(doc, (annot, _page, index) => {
    const rect = annot.getRect().map(round4);
    let quads = 0;
    try { quads = annot.getQuadPoints().length; } catch { quads = 0; }
    return {
      id: annotId(annot),
      page: index,
      rect,
      label: readLabel(annot).slice(0, 160),
      overlay: readOverlay(annot),
      color: readColor(annot).map(round4),
      quads,
    };
  });
}

function styleMark(doc, annot, color, overlay, label) {
  const obj = annot.getObject();
  obj.put("IC", color);
  obj.put("C", color);
  obj.put("OverlayText", `(${latin(overlay)})`);
  if (label !== undefined) {
    try { annot.setContents(String(label).slice(0, 500)); } catch { /* ignore */ }
  }
  paintAppearance(doc, annot, color, overlay);
  annot.update();
}

/**
 * Add one reviewable mark.
 * spec.rect / spec.quads are image pixels unless spec.space is "page".
 */
export function addMark(doc, spec) {
  const index = Number(spec.page);
  checkPage(doc, index);
  const page = doc.loadPage(index);
  const zoom = clampZoom(spec.zoom ?? 1);
  const color = colorOf(spec.color);
  const overlay = overlayText(spec.overlay);
  const pageSpace = spec.space === "page";
  let quads = null;
  let rect = null;
  if (Array.isArray(spec.quads) && spec.quads.length) {
    quads = spec.quads.map((q) => {
      if (!Array.isArray(q) || q.length !== 8 || q.some((v) => !Number.isFinite(Number(v)))) throw httpError(400, "Bad quad");
      const nums = q.map(Number);
      return pageSpace ? nums : imageQuadToPage(page, zoom, nums);
    });
  } else if (Array.isArray(spec.rect) && spec.rect.length === 4) {
    const raw = spec.rect.map(Number);
    if (raw.some((v) => !Number.isFinite(v))) throw httpError(400, "Bad rectangle");
    rect = pageSpace ? raw : userRectToPage(page, imageRectToUser(page, zoom, raw));
    rect = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
    if (rect[2] - rect[0] < 2 || rect[3] - rect[1] < 2) throw httpError(400, "Redaction area is too small");
  } else {
    throw httpError(400, "A rectangle or a text selection is required");
  }
  const annot = page.createAnnotation("Redact");
  if (quads) annot.setQuadPoints(quads);
  else annot.setRect(rect);
  const rawLabel = spec.label != null ? spec.label : spec.contents;
  const label = rawLabel != null && String(rawLabel) !== "" ? String(rawLabel) : quads ? "" : "Area";
  styleMark(doc, annot, color, overlay, label);
  const listed = listMarks(doc).find((m) => m.id === annotId(annot));
  return listed || { id: annotId(annot), page: index };
}

export function addMarks(doc, hits, style = {}) {
  if (!Array.isArray(hits) || !hits.length) throw httpError(400, "No accepted hits");
  const made = [];
  for (const hit of hits) {
    made.push(addMark(doc, {
      page: hit.page,
      space: "page",
      quads: hit.quads,
      rect: hit.rect,
      color: hit.color ?? style.color,
      overlay: hit.overlay ?? style.overlay,
      label: hit.text || hit.label || "",
      zoom: 1,
    }));
  }
  return made;
}

export function setMarkStyle(doc, spec) {
  const color = spec.color === undefined ? null : colorOf(spec.color);
  const overlay = spec.overlay === undefined ? null : overlayText(spec.overlay);
  const marks = [];
  eachRedact(doc, (annot) => {
    styleMark(doc, annot, color || readColor(annot), overlay === null ? readOverlay(annot) : overlay);
    marks.push(annotId(annot));
  });
  return { updated: marks.length, marks: listMarks(doc) };
}

function pageChars(doc, index) {
  const map = textMap(doc, index);
  const chars = [];
  map.lines.forEach((line, li) => {
    for (const ch of line.chars) chars.push({ c: ch.c, q: ch.q, line: li });
    chars.push({ c: "\n", q: null, line: li, br: true });
  });
  return chars;
}

function quadsForRange(chars, start, end) {
  const slice = [];
  for (let i = start; i < end; i++) {
    const ch = chars[i];
    if (ch && ch.q && String(ch.c).trim()) slice.push(ch);
  }
  const quads = [];
  let i = 0;
  while (i < slice.length) {
    const line = slice[i].line;
    let j = i;
    while (j + 1 < slice.length && slice[j + 1].line === line) j++;
    const f = slice[i].q;
    const l = slice[j].q;
    quads.push([f[0], f[1], l[2], l[3], f[4], f[5], l[6], l[7]].map(round4));
    i = j + 1;
  }
  return quads;
}

function patternFor(spec) {
  const kind = spec.pattern || "text";
  if (kind === "text" || kind === "phrase" || kind === "word") {
    const q = String(spec.query ?? "").trim();
    if (!q) throw httpError(400, "Enter a word or phrase");
    if (q.length > 200) throw httpError(400, "Search text is too long");
    const parts = q.split(/\s+/).map(escapeRegExp);
    return { kind: "text", query: q, re: new RegExp(`\\b${parts.join("\\s+")}\\b`, "gi") };
  }
  if (!PATTERNS[kind]) throw httpError(400, "Unknown search pattern");
  const src = PATTERNS[kind].source;
  const flags = PATTERNS[kind].flags.includes("g") ? PATTERNS[kind].flags : PATTERNS[kind].flags + "g";
  return { kind, query: "", re: new RegExp(src, flags) };
}

/** Find candidates on every page. Nothing is marked until the caller accepts hits. */
export function searchRedactions(doc, spec = {}) {
  const { kind, query, re } = patternFor(spec);
  const hits = [];
  const n = doc.countPages();
  let truncated = false;
  for (let p = 0; p < n; p++) {
    const chars = pageChars(doc, p);
    if (!chars.length) continue;
    const text = chars.map((c) => c.c).join("");
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const quads = quadsForRange(chars, m.index, m.index + m[0].length);
      if (!quads.length) continue;
      const from = Math.max(0, m.index - 18);
      const to = Math.min(text.length, m.index + m[0].length + 18);
      const context = text.slice(from, to).replace(/\s+/g, " ").trim();
      hits.push({
        id: `${p}:${hits.length}`,
        page: p,
        text: m[0].replace(/\s+/g, " ").trim(),
        context,
        quads,
      });
      if (hits.length >= SEARCH_CAP) { truncated = true; break; }
    }
    if (truncated) break;
  }
  return { pattern: kind, query, total: hits.length, truncated, hits };
}

function zonesOn(areas, page) {
  const zones = [];
  for (const area of areas) {
    if (area.page !== page) continue;
    for (const r of area.rects) zones.push(r);
  }
  return zones;
}

function clearDictKeys(obj, keys) {
  if (!obj || obj.isNull() || !obj.isDictionary()) return;
  for (const key of keys) {
    try {
      const v = obj.get(key);
      if (v && !v.isNull()) obj.delete(key);
    } catch { /* missing */ }
  }
}

function removeFromArray(arr, pred) {
  if (!arr || arr.isNull() || !arr.isArray()) return;
  for (let i = arr.length - 1; i >= 0; i--) {
    try {
      if (pred(arr.get(i))) arr.delete(i);
    } catch { /* skip */ }
  }
}

function removeCoveredObjects(doc, areas) {
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const zones = zonesOn(areas, i);
    if (!zones.length) continue;
    const page = doc.loadPage(i);
    const covered = [];
    for (const annot of [...page.getAnnotations()]) {
      if (annot.getType() === "Redact") continue;
      covered.push(annot);
    }
    try {
      for (const widget of [...page.getWidgets()]) covered.push(widget);
    } catch { /* no widgets */ }
    const seen = new Set();
    for (const annot of covered) {
      const id = annotId(annot);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      let rect;
      try { rect = annot.getRect(); } catch { continue; }
      if (!zones.some((z) => overlaps(rect, z))) continue;
      const obj = annot.getObject();
      clearDictKeys(obj, ["V", "DV", "RV", "Contents", "RC", "AP"]);
      const parent = obj.get("Parent");
      if (parent && !parent.isNull()) clearDictKeys(parent, ["V", "DV", "RV", "AP"]);
      try { page.deleteAnnotation(annot); } catch { /* already gone */ }
      dropField(doc, obj, parent);
    }
    for (const link of [...page.getLinks()]) {
      let bounds;
      try { bounds = link.getBounds(); } catch { continue; }
      if (zones.some((z) => overlaps(bounds, z))) {
        try { page.deleteLink(link); } catch { /* already gone */ }
      }
    }
  }
}

function dropField(doc, obj, parent) {
  const form = doc.getTrailer().get("Root").get("AcroForm");
  if (!form || form.isNull()) return;
  const fields = form.get("Fields");
  const ids = new Set();
  try { if (obj.isIndirect()) ids.add(obj.asIndirect()); } catch { /* direct */ }
  try { if (parent && !parent.isNull() && parent.isIndirect()) ids.add(parent.asIndirect()); } catch { /* direct */ }
  removeFromArray(fields, (f) => {
    try { return f.isIndirect() && ids.has(f.asIndirect()); } catch { return false; }
  });
}

function ensureFont(doc, pageObj) {
  let res = pageObj.get("Resources");
  if (!res || res.isNull() || !res.isDictionary()) {
    res = doc.newDictionary();
    pageObj.put("Resources", res);
  }
  let font = res.get("Font");
  if (!font || font.isNull() || !font.isDictionary()) {
    font = doc.newDictionary();
    res.put("Font", font);
  }
  if (!font.get("RdOv") || font.get("RdOv").isNull()) font.put("RdOv", overlayFont(doc));
}

function appendStream(doc, pageObj, bytes) {
  const contents = pageObj.get("Contents");
  if (contents && contents.isArray()) {
    contents.push(doc.addStream(bytes, {}));
    return;
  }
  if (contents && contents.isStream()) {
    const prev = Buffer.from(contents.readStream().asUint8Array());
    contents.writeStream(Buffer.concat([prev, bytes]));
    return;
  }
  pageObj.put("Contents", doc.addStream(bytes, {}));
}

function paintBurnedMarks(doc, page, marks) {
  if (!marks.length) return;
  const po = page.getObject();
  ensureFont(doc, po);
  let cs = "";
  for (const mark of marks) {
    const ink = contrast(mark.color);
    for (const rect of mark.rects) {
      const u = pageRectToUser(page, rect);
      const x = u[0];
      const y = u[1];
      const w = u[2] - u[0];
      const h = u[3] - u[1];
      if (w < 0.5 || h < 0.5) continue;
      cs += `q ${mark.color.map(num).join(" ")} rg ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f Q\n`;
      const text = mark.overlay;
      if (!text) continue;
      let size = Math.min(12, Math.max(4, h * 0.62));
      const widthAt = (s) => text.length * s * 0.52;
      while (size > 4 && widthAt(size) > w - 4) size -= 0.5;
      if (widthAt(size) > w - 2) continue;
      const tw = widthAt(size);
      const tx = x + (w - tw) / 2;
      const ty = y + Math.max(0, (h - size * 0.72) / 2);
      cs += `BT /RdOv ${num(size)} Tf ${ink.map(num).join(" ")} rg 1 0 0 1 ${num(tx)} ${num(ty)} Tm (${latin(text)}) Tj ET\n`;
    }
  }
  if (cs) appendStream(doc, po, Buffer.from(cs, "latin1"));
}

function collectAreas(doc, style) {
  const areas = [];
  eachRedact(doc, (annot, _page, index) => {
    let quads = [];
    try { quads = annot.getQuadPoints(); } catch { quads = []; }
    const rects = quads.length ? quads.map((q) => quadBounds(Array.from(q))) : [annot.getRect()];
    const color = style.color ? colorOf(style.color) : readColor(annot);
    const overlay = style.overlay !== undefined ? overlayText(style.overlay) : readOverlay(annot);
    areas.push({ page: index, rects, color, overlay });
  });
  return areas;
}

/**
 * Permanently remove content under every mark.
 * style.color / style.overlay, when set, override the per-mark settings.
 */
export function applyRedactions(doc, style = {}) {
  const areas = collectAreas(doc, style);
  if (!areas.length) throw httpError(400, "There are no redaction marks to apply");
  removeCoveredObjects(doc, areas);
  if (style.sanitize) removeHiddenLayers(doc);
  const byPage = new Map();
  for (const area of areas) {
    if (!byPage.has(area.page)) byPage.set(area.page, []);
    byPage.get(area.page).push(area);
  }
  for (const [index, marks] of byPage) {
    const page = doc.loadPage(index);
    page.applyRedactions(
      true,
      mupdf.PDFPage.REDACT_IMAGE_PIXELS,
      mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED,
      mupdf.PDFPage.REDACT_TEXT_REMOVE,
    );
    paintBurnedMarks(doc, page, marks);
  }
  let sanitized = false;
  if (style.sanitize) {
    sanitizeDocument(doc, areas);
    sanitized = true;
  }
  return { applied: areas.length, sanitized, areas: areas.map((a) => ({ page: a.page, rects: a.rects.map((r) => r.map(round4)) })) };
}

// ---------- sanitize ----------

function deleteKeys(obj) {
  if (!obj || obj.isNull() || !obj.isDictionary()) return;
  const keys = [];
  try { obj.forEach((_v, k) => keys.push(k)); } catch { return; }
  for (const k of keys) {
    try { obj.delete(k); } catch { /* ignore */ }
  }
}

function clearMetadata(doc) {
  const trailer = doc.getTrailer();
  const info = trailer.get("Info");
  deleteKeys(info);
  try { trailer.delete("Info"); } catch { /* none */ }
  for (const key of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate", "Trapped"]) {
    try { doc.setMetaData(`info:${key}`, ""); } catch { /* ignore */ }
  }
}

function clearXmp(doc) {
  const root = doc.getTrailer().get("Root");
  try { root.delete("Metadata"); } catch { /* none */ }
  try { root.delete("PieceInfo"); } catch { /* none */ }
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const po = doc.loadPage(i).getObject();
    try { po.delete("Metadata"); } catch { /* none */ }
    try { po.delete("PieceInfo"); } catch { /* none */ }
  }
}

function removeAttachments(doc) {
  let names = [];
  try { names = Object.keys(doc.getEmbeddedFiles()); } catch { names = []; }
  for (const name of names) {
    try { doc.deleteEmbeddedFile(name); } catch { /* already gone */ }
  }
  const root = doc.getTrailer().get("Root");
  const nameTree = root.get("Names");
  if (nameTree && nameTree.isDictionary()) {
    try { nameTree.delete("EmbeddedFiles"); } catch { /* none */ }
  }
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    for (const annot of [...page.getAnnotations()]) {
      if (annot.getType() === "FileAttachment") {
        try { page.deleteAnnotation(annot); } catch { /* ignore */ }
      }
    }
  }
}

function isJavaScript(obj) {
  if (!obj || obj.isNull() || !obj.isDictionary()) return false;
  try {
    const s = obj.get("S");
    return !!(s && !s.isNull() && s.isName() && s.asName() === "JavaScript");
  } catch {
    return false;
  }
}

function scrubAction(dict, key) {
  if (!dict || dict.isNull() || !dict.isDictionary()) return;
  try {
    if (isJavaScript(dict.get(key))) dict.delete(key);
  } catch { /* ignore */ }
}

function removeJavaScript(doc) {
  const root = doc.getTrailer().get("Root");
  scrubAction(root, "OpenAction");
  try { root.delete("AA"); } catch { /* none */ }
  const names = root.get("Names");
  if (names && names.isDictionary()) {
    try { names.delete("JavaScript"); } catch { /* none */ }
  }
  const form = root.get("AcroForm");
  if (form && form.isDictionary()) {
    try { form.delete("AA"); } catch { /* none */ }
    scrubAction(form, "A");
  }
  const nobj = doc.countObjects();
  for (let i = 1; i < nobj; i++) {
    let obj;
    try { obj = doc.newIndirect(i); } catch { continue; }
    if (!obj || obj.isNull() || !obj.isDictionary()) continue;
    if (!isJavaScript(obj)) continue;
    try { obj.delete("JS"); } catch { /* ignore */ }
    try { obj.delete("S"); } catch { /* ignore */ }
  }
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    const po = page.getObject();
    try { po.delete("AA"); } catch { /* none */ }
    scrubAction(po, "A");
    for (const annot of page.getAnnotations()) {
      const o = annot.getObject();
      try { o.delete("AA"); } catch { /* none */ }
      scrubAction(o, "A");
    }
  }
}

function hiddenOcgIds(doc) {
  const ids = new Set();
  const names = new Set();
  const root = doc.getTrailer().get("Root");
  const props = root.get("OCProperties");
  if (props && props.isDictionary()) {
    const off = props.get("D")?.get("OFF");
    if (off && off.isArray()) {
      for (let i = 0; i < off.length; i++) {
        const o = off.get(i);
        try { if (o.isIndirect()) ids.add(o.asIndirect()); } catch { /* skip */ }
        try {
          const nm = o.get("Name");
          if (nm && nm.isString()) names.add(nm.asString());
        } catch { /* skip */ }
      }
    }
  }
  try {
    const n = doc.countLayers();
    for (let i = 0; i < n; i++) {
      if (!doc.isLayerVisible(i)) names.add(doc.getLayerName(i));
    }
  } catch { /* no layers */ }
  return { ids, names };
}

function propertyNamesFor(doc, res, hidden) {
  const found = new Set();
  if (!res || res.isNull()) return found;
  const props = res.get("Properties");
  if (!props || props.isNull() || !props.isDictionary()) return found;
  props.forEach((val, key) => {
    let id = 0;
    let name = "";
    try { if (val.isIndirect()) id = val.asIndirect(); } catch { id = 0; }
    try {
      const nm = val.get("Name");
      if (nm && nm.isString()) name = nm.asString();
    } catch { name = ""; }
    if ((id && hidden.ids.has(id)) || (name && hidden.names.has(name))) found.add(String(key));
  });
  return found;
}

function stripMarked(content, names) {
  if (!names.size || !content) return content;
  let out = "";
  let i = 0;
  const s = content;
  while (i < s.length) {
    const bdc = s.indexOf("BDC", i);
    if (bdc < 0) { out += s.slice(i); break; }
    const head = s.slice(Math.max(0, bdc - 64), bdc);
    const m = head.match(/\/OC\s+\/([A-Za-z0-9_.#]+)\s*$/);
    if (!m) {
      out += s.slice(i, bdc + 3);
      i = bdc + 3;
      continue;
    }
    let depth = 1;
    let j = bdc + 3;
    while (j < s.length && depth > 0) {
      const nextB = s.indexOf("BDC", j);
      const nextE = s.indexOf("EMC", j);
      if (nextE < 0) { j = s.length; break; }
      if (nextB >= 0 && nextB < nextE) { depth++; j = nextB + 3; }
      else { depth--; j = nextE + 3; }
    }
    const start = bdc - m[0].length;
    if (names.has(m[1])) {
      out += s.slice(i, start);
    } else {
      out += s.slice(i, j);
    }
    i = j;
  }
  return out;
}

function rewriteStream(obj, names) {
  if (!obj || obj.isNull() || !obj.isStream() || !names.size) return;
  let raw;
  try { raw = Buffer.from(obj.readStream().asUint8Array()).toString("latin1"); } catch { return; }
  const next = stripMarked(raw, names);
  if (next !== raw) {
    try { obj.writeStream(Buffer.from(next, "latin1")); } catch { /* ignore */ }
  }
}

function removeHiddenLayers(doc) {
  const hidden = hiddenOcgIds(doc);
  const root = doc.getTrailer().get("Root");
  if (!hidden.ids.size && !hidden.names.size && (!root.get("OCProperties") || root.get("OCProperties").isNull())) return;
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const po = doc.loadPage(i).getObject();
    const names = propertyNamesFor(doc, po.get("Resources"), hidden);
    const contents = po.get("Contents");
    if (contents && contents.isArray()) {
      for (let k = 0; k < contents.length; k++) rewriteStream(contents.get(k), names);
    } else {
      rewriteStream(contents, names);
    }
    const xo = po.get("Resources")?.get("XObject");
    if (xo && xo.isDictionary()) {
      xo.forEach((val) => {
        try {
          const sub = val.get("Subtype");
          const kind = sub && sub.isName() ? sub.asName() : "";
          if (kind === "Form") rewriteStream(val, names.size ? names : hidden.names);
        } catch { /* skip */ }
      });
    }
  }
  try { root.delete("OCProperties"); } catch { /* none */ }
}

function removeComments(doc) {
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    for (const annot of [...page.getAnnotations()]) {
      const type = annot.getType();
      if (type === "Redact" || type === "Widget" || type === "Link") continue;
      if (!COMMENT_TYPES.has(type)) continue;
      try { page.deleteAnnotation(annot); } catch { /* ignore */ }
    }
  }
}

function destInside(doc, uri, areas) {
  if (!uri || typeof uri !== "string") return false;
  if (/^[a-z]+:/i.test(uri) && !uri.startsWith("#")) return false;
  let dest;
  try { dest = doc.resolveLinkDestination(uri); } catch { return false; }
  if (!dest || !Number.isInteger(dest.page)) return false;
  const zones = zonesOn(areas, dest.page);
  if (!zones.length) return false;
  if (dest.type === "Fit" || dest.type === "FitB") return false;
  let pt;
  try {
    pt = userPointToPage(doc.loadPage(dest.page), [dest.x, dest.y]);
  } catch {
    pt = [dest.x, dest.y];
  }
  return zones.some((z) => pointIn(pt[0], pt[1], z));
}

function removeDestinations(doc, areas) {
  if (!areas.length) return { links: 0, bookmarks: 0 };
  let links = 0;
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    for (const link of [...page.getLinks()]) {
      let uri = "";
      try { uri = link.getURI(); } catch { uri = ""; }
      if (!destInside(doc, uri, areas)) continue;
      try { page.deleteLink(link); links++; } catch { /* ignore */ }
    }
  }
  let bookmarks = 0;
  try {
    const it = doc.outlineIterator();
    if (!it.item() && it.next() !== 0) return { links, bookmarks };
    const walkLevel = () => {
      let guard = 0;
      while (it.item() && guard++ < 10000) {
        const item = it.item();
        if (item && destInside(doc, item.uri, areas)) {
          it.delete();
          bookmarks++;
          if (!it.item()) break;
          continue;
        }
        if (it.down() === 0) {
          walkLevel();
          it.up();
        }
        if (it.next() !== 0) break;
      }
    };
    walkLevel();
  } catch { /* no outline */ }
  return { links, bookmarks };
}

/** Remove hidden information. `areas` are page-space rects already redacted or marked. */
export function sanitizeDocument(doc, areas = []) {
  clearMetadata(doc);
  clearXmp(doc);
  removeAttachments(doc);
  removeJavaScript(doc);
  removeHiddenLayers(doc);
  removeComments(doc);
  const dest = removeDestinations(doc, areas);
  return { sanitized: true, ...dest };
}

export function suggestedName(name) {
  const base = String(name || "document.pdf").replace(/\.pdf$/i, "");
  const clean = base.replace(/[^\w.\- ]+/g, "_").trim() || "document";
  return `${clean}_redacted.pdf`;
}

/** True when `needle` survives in the file, including inside Flate streams. */
export function pdfContains(buf, needle) {
  const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const ascii = Buffer.from(String(needle), "latin1");
  if (raw.includes(ascii)) return true;
  const wide = Buffer.alloc(needle.length * 2);
  for (let i = 0; i < needle.length; i++) wide.writeUInt16BE(needle.charCodeAt(i), i * 2);
  if (raw.includes(wide)) return true;
  const bom = Buffer.concat([Buffer.from([0xfe, 0xff]), wide]);
  if (raw.includes(bom)) return true;
  let i = 0;
  while (i < raw.length - 12) {
    const idx = raw.indexOf("stream", i);
    if (idx < 0) break;
    const prev = idx > 0 ? raw[idx - 1] : 10;
    if (prev !== 10 && prev !== 13 && prev !== 32 && prev !== 9) { i = idx + 6; continue; }
    let start = idx + 6;
    if (raw[start] === 13 && raw[start + 1] === 10) start += 2;
    else if (raw[start] === 10 || raw[start] === 13) start += 1;
    else { i = idx + 6; continue; }
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    let dataEnd = end;
    if (dataEnd > start && raw[dataEnd - 1] === 10) dataEnd--;
    if (dataEnd > start && raw[dataEnd - 1] === 13) dataEnd--;
    const look = Math.max(0, idx - 400);
    const dict = raw.subarray(look, idx).toString("latin1");
    const data = raw.subarray(start, dataEnd);
    if (/FlateDecode/.test(dict)) {
      let inflated = null;
      try { inflated = zlib.inflateSync(data); } catch {
        try { inflated = zlib.inflateRawSync(data); } catch { inflated = null; }
      }
      if (inflated && (inflated.includes(ascii) || inflated.includes(wide) || inflated.includes(bom))) return true;
    }
    i = end + 9;
  }
  return false;
}

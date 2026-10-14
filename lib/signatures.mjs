// Reusable signature and initials pictures live in the app data folder.
// Placing one adds a stamp annotation that can be moved and resized.
// Saving the document burns those stamps into the page content.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as mupdf from "mupdf";
import { SIGN_PREFIX, createAnnot, describeAnnot, findAnnot, httpError, rawUserRect, saveBytes, openBytes } from "./pdf.mjs";

const ID_RE = /^[a-f0-9]{16}$/;
const KINDS = new Set(["signature", "initials"]);
const MODES = new Set(["draw", "type", "image"]);

export function signatureDir(dataDir) {
  return path.join(dataDir, "signatures");
}

function indexPath(dir) {
  return path.join(dir, "index.json");
}

function readIndex(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(indexPath(dir), "utf8"));
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

function writeIndex(dir, items) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.index-${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2));
  fs.renameSync(tmp, indexPath(dir));
}

function publicItem(item) {
  return {
    id: item.id,
    kind: item.kind,
    mode: item.mode,
    created: item.created,
  };
}

export function listSignatures(dataDir) {
  return readIndex(signatureDir(dataDir)).map(publicItem);
}

export function signatureFile(dataDir, id) {
  if (!ID_RE.test(String(id || ""))) throw httpError(400, "Unknown signature");
  const file = path.join(signatureDir(dataDir), `${id}.png`);
  if (!file.startsWith(signatureDir(dataDir) + path.sep)) throw httpError(400, "Unknown signature");
  return file;
}

export function readSignature(dataDir, id) {
  const file = signatureFile(dataDir, id);
  if (!fs.existsSync(file)) throw httpError(404, "Saved signature not found");
  return fs.readFileSync(file);
}

export function saveSignature(dataDir, png, { kind = "signature", mode = "draw" } = {}) {
  if (!png || png.length < 16) throw httpError(400, "Signature image required");
  if (png.length > 4 * 1024 * 1024) throw httpError(400, "Signature image is too large");
  if (!KINDS.has(kind)) throw httpError(400, "Kind must be signature or initials");
  if (!MODES.has(mode)) throw httpError(400, "Unknown signature source");
  const dir = signatureDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomBytes(8).toString("hex");
  const item = { id, kind, mode, created: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, `${id}.png`), png);
  const items = readIndex(dir).filter((it) => it.id !== id);
  items.unshift(item);
  writeIndex(dir, items.slice(0, 40));
  return publicItem(item);
}

export function deleteSignature(dataDir, id) {
  const file = signatureFile(dataDir, id);
  const dir = signatureDir(dataDir);
  fs.rmSync(file, { force: true });
  writeIndex(dir, readIndex(dir).filter((it) => it.id !== id));
  return { ok: true };
}

function pdfLatin(text) {
  let out = "";
  for (const ch of String(text)) {
    let cp = ch.codePointAt(0);
    if (cp === 0x2019 || cp === 0x2018) cp = 0x27;
    else if (cp === 0x201c || cp === 0x201d) cp = 0x22;
    else if (cp === 0x2013 || cp === 0x2014) cp = 0x2d;
    if (cp < 32 || cp > 255) cp = 0x3f;
    const c = String.fromCharCode(cp);
    out += c === "(" || c === ")" || c === "\\" ? "\\" + c : c;
  }
  return out;
}

/** A transparent PNG of italic text, used for a typed signature or initials. */
export function renderTypedSignature(text, { width = 480, height = 140, kind = "signature" } = {}) {
  const clean = String(text || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80);
  if (!clean) throw httpError(400, "Type a signature first");
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Times-Italic"));
  const res = doc.addObject({ Font: { F1: font } });
  const size = Math.max(18, Math.min(kind === "initials" ? 72 : 56, (width - 28) / Math.max(1, clean.length * 0.45)));
  const y = Math.max(18, (height - size) / 2);
  const content = `BT /F1 ${size.toFixed(2)} Tf 0 0 0 rg 1 0 0 1 16 ${y.toFixed(2)} Tm (${pdfLatin(clean)}) Tj ET`;
  doc.insertPage(0, doc.addPage([0, 0, width, height], 0, res, content));
  const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, true);
  try {
    return Buffer.from(pix.asPNG());
  } finally {
    try { pix.destroy(); } catch { /* gone */ }
  }
}

function setPlacedFlag(doc, on) {
  try {
    doc.getTrailer().get("Root").put("RedlinePlacedSigs", on ? 1 : 0);
  } catch {
    /* no catalog */
  }
}

/** True when this document has a signature or initials picture waiting to be stamped. */
export function hasPlacedFlag(doc) {
  try {
    const v = doc.getTrailer().get("Root").get("RedlinePlacedSigs");
    if (!v || v.isNull()) return false;
    return v.asNumber() > 0;
  } catch {
    return false;
  }
}

export function placeSignature(doc, { page, zoom, rect, png, kind = "signature", author } = {}) {
  if (!KINDS.has(kind)) throw httpError(400, "Kind must be signature or initials");
  if (!png || png.length < 16) throw httpError(400, "Signature image required");
  const created = createAnnot(doc, {
    page,
    zoom,
    tool: "image-stamp",
    rect,
    imageBytes: png,
    label: kind === "initials" ? "Initials" : "Signature",
    author,
  });
  const found = findAnnot(doc, created.id);
  if (!found) throw httpError(500, "Could not place the signature");
  found.annot.setSubject(SIGN_PREFIX + kind);
  found.annot.update();
  setPlacedFlag(doc, true);
  return describeAnnot(found.annot, found.index);
}

/** Draw a PNG into the page content at a user-space rectangle. */
export function paintImageOnPage(doc, page, userRect, pngBytes) {
  if (!pngBytes || pngBytes.length < 16) return false;
  const x = Math.min(userRect[0], userRect[2]);
  const y = Math.min(userRect[1], userRect[3]);
  const w = Math.abs(userRect[2] - userRect[0]);
  const h = Math.abs(userRect[3] - userRect[1]);
  if (!(w >= 1 && h >= 1)) return false;
  const image = new mupdf.Image(pngBytes);
  const ref = doc.addImage(image);
  const pageObj = page.getObject();
  const res = resourcesOf(doc, pageObj);
  let xobj = res.get("XObject");
  if (!xobj || xobj.isNull()) {
    xobj = doc.newDictionary();
    res.put("XObject", xobj);
  }
  const name = `RlSig${ref.asIndirect()}`;
  xobj.put(name, ref);
  appendStream(doc, pageObj, `q ${w.toFixed(3)} 0 0 ${h.toFixed(3)} ${x.toFixed(3)} ${y.toFixed(3)} cm /${name} Do Q\n`);
  return true;
}

function isPlaced(annot) {
  try {
    const subj = annot.getSubject() || "";
    return subj === `${SIGN_PREFIX}signature` || subj === `${SIGN_PREFIX}initials`;
  } catch {
    return false;
  }
}

export function countPlacedSignatures(doc) {
  let n = 0;
  const pages = doc.countPages();
  for (let i = 0; i < pages; i++) {
    for (const a of doc.loadPage(i).getAnnotations()) if (isPlaced(a)) n++;
  }
  return n;
}

function appendStream(doc, pageObj, piece) {
  const stream = doc.addStream(Buffer.from(piece), {});
  const contents = pageObj.get("Contents");
  if (!contents || contents.isNull()) pageObj.put("Contents", stream);
  else if (contents.isArray()) contents.push(stream);
  else pageObj.put("Contents", [contents, stream]);
}

function resourcesOf(doc, pageObj) {
  let res = pageObj.get("Resources");
  if (res && !res.isNull()) return res;
  try {
    const inherited = pageObj.getInheritable("Resources");
    if (inherited && !inherited.isNull()) return inherited;
  } catch {
    /* none */
  }
  res = doc.addObject({});
  pageObj.put("Resources", res);
  return res;
}

function burnAnnot(doc, page, annot) {
  const user = rawUserRect(doc, annot.getObject().asIndirect());
  if (!user || user.length !== 4) return false;
  const scale = 2;
  const pix = annot.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, true);
  let png;
  try {
    png = Buffer.from(pix.asPNG());
  } finally {
    try { pix.destroy(); } catch { /* gone */ }
  }
  if (!png || png.length < 16) return false;
  const image = new mupdf.Image(png);
  const ref = doc.addImage(image);
  const pageObj = page.getObject();
  const res = resourcesOf(doc, pageObj);
  let xobj = res.get("XObject");
  if (!xobj || xobj.isNull()) {
    xobj = doc.newDictionary();
    res.put("XObject", xobj);
  }
  const name = `RlSig${ref.asIndirect()}`;
  xobj.put(name, ref);
  const x = Math.min(user[0], user[2]);
  const y = Math.min(user[1], user[3]);
  const w = Math.abs(user[2] - user[0]);
  const h = Math.abs(user[3] - user[1]);
  appendStream(doc, pageObj, `q ${w.toFixed(3)} 0 0 ${h.toFixed(3)} ${x.toFixed(3)} ${y.toFixed(3)} cm /${name} Do Q\n`);
  return true;
}

/**
 * Copy placed signature and initials stamps into the page content and remove
 * the annotations. Returns the same document; a later save writes the ink
 * into the file. Other markup is left in place.
 */
export function bakePlacedSignatures(doc) {
  let count = 0;
  const pages = doc.countPages();
  for (let i = 0; i < pages; i++) {
    const page = doc.loadPage(i);
    const doomed = page.getAnnotations().filter(isPlaced);
    for (const annot of doomed) {
      if (burnAnnot(doc, page, annot)) {
        page.deleteAnnotation(annot);
        count++;
      }
    }
  }
  return { count };
}

/** Save helper: bake placed signatures on a copy and return that document. */
export function documentWithStampedSignatures(doc) {
  if (!countPlacedSignatures(doc)) {
    setPlacedFlag(doc, false);
    return { doc, count: 0, changed: false };
  }
  const copy = openBytes(new Uint8Array(saveBytes(doc)));
  const { count } = bakePlacedSignatures(copy);
  setPlacedFlag(copy, false);
  const fresh = openBytes(new Uint8Array(saveBytes(copy)));
  try { copy.destroy(); } catch { /* already gone */ }
  return { doc: fresh, count, changed: count > 0 };
}

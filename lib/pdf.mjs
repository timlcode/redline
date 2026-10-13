// All MuPDF work for Redline.
//
// Coordinate spaces:
//   PDF user space  - what the file stores (/Rect, /QuadPoints, ...), origin bottom-left.
//   page space      - MuPDF's view space: user space through page.getTransform(), which
//                     applies /Rotate, /MediaBox offset and the y-flip. Origin top-left of
//                     the page as the user sees it.
//   image space     - PNG pixels = page space * zoom.
// MuPDF's annotation setters/getters (setRect, setLine, setQuadPoints, setInkList, ...)
// take page space and convert to user space themselves, and page.toPixmap() applies
// page.getTransform() internally. So the render matrix for an upright PNG is
// scale(zoom), and image -> user space is invert(getTransform() * scale(zoom)).
import * as mupdf from "mupdf";

export const STAMPS = ["APPROVED", "REVISE", "REJECT", "FOR REVIEW"];
export const STAMP_PREFIX = "redline-stamp:";
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

const PRINT = mupdf.PDFAnnotation.IS_PRINT ?? 4;
const HIDDEN = mupdf.PDFAnnotation.IS_HIDDEN ?? 2;
let defaultAuthor = "Redline";
export function setDefaultAuthor(name) {
  defaultAuthor = String(name || "").trim() || "Redline";
}
export function getDefaultAuthor() {
  return defaultAuthor;
}

export function clampZoom(z) {
  const n = Number(z);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n));
}

// ---------- matrices ----------

export function renderMatrix(page, zoom) {
  void page;
  return mupdf.Matrix.scale(zoom, zoom);
}

// user space -> image pixels (what the renderer effectively does)
export function userToImageMatrix(page, zoom) {
  return mupdf.Matrix.concat(page.getTransform(), mupdf.Matrix.scale(zoom, zoom));
}

export function imageToUserMatrix(page, zoom) {
  return mupdf.Matrix.invert(userToImageMatrix(page, zoom));
}

function tp([x, y], m) {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

function normRect(r) {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

function tr(r, m) {
  const pts = [tp([r[0], r[1]], m), tp([r[2], r[1]], m), tp([r[0], r[3]], m), tp([r[2], r[3]], m)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function imagePointToUser(page, zoom, pt) {
  return tp(pt, imageToUserMatrix(page, zoom));
}

export function imageRectToUser(page, zoom, rect) {
  return tr(rect, imageToUserMatrix(page, zoom));
}

export function userPointToPage(page, pt) {
  return tp(pt, page.getTransform());
}

export function userRectToPage(page, rect) {
  return tr(rect, page.getTransform());
}

// image pixels -> page space, routed through user space so both sides share one matrix
function imgPt(page, zoom, pt) {
  return userPointToPage(page, imagePointToUser(page, zoom, pt));
}

function imgRect(page, zoom, rect) {
  return userRectToPage(page, imageRectToUser(page, zoom, normRect(rect)));
}

// ---------- documents ----------

export function newBlankDocument(pages = 1, width = 612, height = 792) {
  const doc = new mupdf.PDFDocument();
  for (let i = 0; i < pages; i++) {
    doc.insertPage(i, doc.addPage([0, 0, width, height], 0, {}, " "));
  }
  return doc;
}

export function isPdfBytes(bytes) {
  if (!bytes || bytes.length < 5) return false;
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 1024))).toString("latin1");
  return head.includes("%PDF");
}

// MuPDF 1.28.1 (npm "mupdf") write options, checked against that build:
//   encrypt=aes-256  -> Standard V5 R6 256-bit AES
//   user-password    -> open password (empty = open without a prompt)
//   owner-password   -> permissions password
//   permissions      -> bitfield; pdf_new_encrypt keeps bits 2-5 and 8-11
//   encrypt=keep     -> default of saveToBuffer("garbage"); leaves the current crypt
//   encrypt=none     -> write a decrypted file
// needsPassword() authenticates with "" as a side effect and clears a real
// password, so it is called once, before authenticatePassword, and never again.
// Passwords are only placed in the MuPDF options string for the duration of
// the save call. They are not written to logs, settings, or error text.

const PERM_PRINT = 1 << 2;
const PERM_MODIFY = 1 << 3;
const PERM_COPY = 1 << 4;
const PERM_ANNOTATE = 1 << 5;
const PERM_FORM = 1 << 8;
const PERM_ACCESSIBILITY = 1 << 9;
const PERM_ASSEMBLE = 1 << 10;
const PERM_PRINT_HQ = 1 << 11;
const PASSWORD_BYTES = 127;

export function permissionBits({ print = true, copy = true, edit = true } = {}) {
  let p = 0;
  if (print) p |= PERM_PRINT | PERM_PRINT_HQ;
  if (copy) p |= PERM_COPY | PERM_ACCESSIBILITY;
  if (edit) p |= PERM_MODIFY | PERM_ANNOTATE | PERM_FORM | PERM_ASSEMBLE;
  return p;
}

export function passwordError(code, message) {
  const e = httpError(401, message);
  e.code = code;
  return e;
}

function dropDoc(doc) {
  try { doc.destroy(); } catch { /* already gone */ }
}

/**
 * Open PDF bytes. `password` is the open password (user password).
 * Permissions-only files (owner password, empty user password) open with no
 * password. Returns { doc, passwordRequired }.
 * Never include `password` in a thrown message.
 */
export function openPdf(bytes, password) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const pdf = doc.asPDF();
  if (!pdf) {
    dropDoc(doc);
    throw httpError(400, "Not a PDF");
  }
  const supplied = typeof password === "string" ? password : undefined;
  let passwordRequired = false;
  try {
    passwordRequired = pdf.needsPassword();
  } catch (e) {
    dropDoc(pdf);
    throw e;
  }
  if (passwordRequired) {
    if (supplied === undefined) {
      dropDoc(pdf);
      throw passwordError("password-required", "This PDF needs a password to open");
    }
    let auth = 0;
    try { auth = pdf.authenticatePassword(supplied); } catch (e) {
      dropDoc(pdf);
      throw e;
    }
    if (!auth) {
      dropDoc(pdf);
      throw passwordError("password", "Incorrect password");
    }
  } else if (supplied) {
    // Optional owner password on a file that already opens. A wrong one must
    // not clear the empty-password user access that needsPassword() just set.
    let auth = 0;
    try { auth = pdf.authenticatePassword(supplied); } catch { auth = 0; }
    if (!auth) {
      try { pdf.authenticatePassword(""); } catch { /* unencrypted */ }
    }
  }
  return { doc: pdf, passwordRequired };
}

export function openBytes(bytes, password) {
  return openPdf(bytes, password).doc;
}

// MuPDF 1.28 labels encrypt=aes-256 this way. saveToBuffer updates the crypt
// used by the next save, but getMetaData("encryption") and hasPermission keep
// the values from when the document was opened.
const AES256_METHOD = "Standard V5 R6 256-bit AES";
const protectionOverride = new WeakMap();

export function protectionInfo(doc) {
  const written = protectionOverride.get(doc);
  if (written) return { ...written };
  let method = "None";
  try { method = doc.getMetaData("encryption") || "None"; } catch { method = "None"; }
  const encrypted = method !== "None";
  return {
    encrypted,
    method: encrypted ? method : null,
    print: doc.hasPermission("print"),
    copy: doc.hasPermission("copy"),
    edit: doc.hasPermission("edit"),
  };
}

function rememberProtection(doc, spec) {
  if (!spec || spec.mode === "keep") return;
  if (spec.mode === "none") {
    protectionOverride.set(doc, { encrypted: false, method: null, print: true, copy: true, edit: true });
    return;
  }
  protectionOverride.set(doc, {
    encrypted: true,
    method: AES256_METHOD,
    print: !!spec.print,
    copy: !!spec.copy,
    edit: !!spec.edit,
  });
}

/** Turn a save/protect choice into a spec saveBytes understands. Drops unknown modes. */
export function normalizeProtection(input) {
  const mode = input && input.mode ? input.mode : "keep";
  if (mode === "keep") return { mode: "keep" };
  if (mode === "none") return { mode: "none" };
  if (mode !== "password") throw httpError(400, "Unknown protection choice");
  const userPassword = String(input.userPassword ?? "");
  const ownerIn = String(input.ownerPassword ?? "");
  if (Buffer.byteLength(userPassword) > PASSWORD_BYTES || Buffer.byteLength(ownerIn) > PASSWORD_BYTES) {
    throw httpError(400, "Password is too long");
  }
  const print = input.print !== false;
  const copy = input.copy !== false;
  const edit = input.edit !== false;
  const restricted = !print || !copy || !edit;
  if (!userPassword && !restricted && !ownerIn) return { mode: "none" };
  let ownerPassword = ownerIn;
  if (restricted) {
    if (!ownerPassword) throw httpError(400, "A permissions password is required to restrict printing, copying, or editing");
    if (ownerPassword === userPassword) throw httpError(400, "The permissions password must differ from the open password");
  } else if (!ownerPassword) {
    ownerPassword = userPassword;
  }
  return {
    mode: "password",
    userPassword,
    ownerPassword,
    print,
    copy,
    edit,
    permissions: permissionBits({ print, copy, edit }),
  };
}

function protectionOptions(spec) {
  if (spec.mode === "none") return JSON.stringify({ garbage: true, encrypt: "none" });
  // JSON options so a comma or quote in a password cannot break the parser
  // or inject another write option. MuPDF 1.28 unescapes JSON strings.
  return JSON.stringify({
    garbage: true,
    encrypt: "aes-256",
    "user-password": spec.userPassword,
    "owner-password": spec.ownerPassword,
    permissions: spec.permissions,
  });
}

export function saveBytes(doc, protection) {
  const spec = protection && protection.mode && protection.mode !== "keep" ? protection : null;
  if (!spec) return Buffer.from(doc.saveToBuffer("garbage").asUint8Array());
  const options = protectionOptions(spec);
  let bytes;
  try {
    bytes = Buffer.from(doc.saveToBuffer(options).asUint8Array());
  } catch {
    // The MuPDF error can echo the options string. Never surface that.
    throw httpError(400, "Could not save with that password protection");
  }
  rememberProtection(doc, spec);
  return bytes;
}

export function pageSizes(doc) {
  const n = doc.countPages();
  const out = [];
  for (let i = 0; i < n; i++) {
    const b = doc.loadPage(i).getBounds();
    out.push({ width: b[2] - b[0], height: b[3] - b[1], rotate: getRotate(doc, i) });
  }
  return out;
}

function checkPage(doc, index) {
  const n = doc.countPages();
  if (!Number.isInteger(index) || index < 0 || index >= n) throw httpError(400, `No page ${index}`);
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------- rendering ----------

function pngOf(pix) {
  const png = Buffer.from(pix.asPNG());
  pix.destroy();
  return png;
}

export function renderPage(doc, index, zoom = 1) {
  checkPage(doc, index);
  const page = doc.loadPage(index);
  const z = clampZoom(zoom);
  const pix = page.toPixmap(renderMatrix(page, z), mupdf.ColorSpace.DeviceRGB, false, true);
  return pngOf(pix);
}

export function renderThumb(doc, index, width = 140, token = 0) {
  checkPage(doc, index);
  const page = doc.loadPage(index);
  const b = page.getBounds();
  const z = Math.max(0.05, width / Math.max(1, b[2] - b[0]));
  const key = `thumb:${docId(doc)}:${token}:${index}:${width}`;
  const hit = takeTile(key);
  if (hit) return hit;
  const pix = page.toPixmap(mupdf.Matrix.scale(z, z), mupdf.ColorSpace.DeviceRGB, false, true);
  const png = pngOf(pix);
  storeTile(docId(doc), token, key, png);
  return png;
}

// Visible-area rendering. The viewer asks for fixed grid tiles instead of a
// full-page PNG, and the display list for a page is reused across tiles and
// zoom changes (token must change when the page contents change).
export const VIEW_TILE = 512;
export const TILE_MAX = 1024;
const DL_LIMIT = 3;
const TILE_BYTE_LIMIT = 64 * 1024 * 1024;

let docSerial = 1;
const docIds = new WeakMap();
function docId(doc) {
  let id = docIds.get(doc);
  if (!id) {
    id = docSerial++;
    docIds.set(doc, id);
  }
  return id;
}

const dlCache = [];
const tileCache = [];
let tileBytes = 0;

function dropOtherTokens(id, token) {
  for (let i = dlCache.length - 1; i >= 0; i--) {
    if (dlCache[i].id === id && dlCache[i].token !== token) {
      try { dlCache[i].dl.destroy(); } catch { /* already gone */ }
      dlCache.splice(i, 1);
    }
  }
  for (let i = tileCache.length - 1; i >= 0; i--) {
    if (tileCache[i].id === id && tileCache[i].token !== token) {
      tileBytes -= tileCache[i].png.length;
      tileCache.splice(i, 1);
    }
  }
}

function displayListFor(doc, index, token) {
  const id = docId(doc);
  dropOtherTokens(id, token);
  const hit = dlCache.find((e) => e.id === id && e.token === token && e.index === index);
  if (hit) return hit.dl;
  const dl = doc.loadPage(index).toDisplayList(true);
  dlCache.push({ id, token, index, dl });
  while (dlCache.length > DL_LIMIT) {
    const old = dlCache.shift();
    try { old.dl.destroy(); } catch { /* already gone */ }
  }
  return dl;
}

function takeTile(key) {
  const i = tileCache.findIndex((e) => e.key === key);
  if (i < 0) return null;
  const [hit] = tileCache.splice(i, 1);
  tileCache.push(hit);
  return hit.png;
}

function storeTile(id, token, key, png) {
  tileCache.push({ id, token, key, png });
  tileBytes += png.length;
  while (tileBytes > TILE_BYTE_LIMIT && tileCache.length > 1) {
    const old = tileCache.shift();
    tileBytes -= old.png.length;
  }
}

export function pagePixelSize(doc, index, zoom) {
  checkPage(doc, index);
  const b = doc.loadPage(index).getBounds();
  const z = clampZoom(zoom);
  return {
    zoom: z,
    width: Math.max(1, Math.ceil((b[2] - b[0]) * z)),
    height: Math.max(1, Math.ceil((b[3] - b[1]) * z)),
  };
}

/** Grid tiles (origin multiples of `tile`) that intersect `view` and the page. */
export function tilesCovering(pageW, pageH, view, tile = VIEW_TILE) {
  const x0 = Math.max(0, view.x);
  const y0 = Math.max(0, view.y);
  const x1 = Math.min(pageW, view.x + view.w);
  const y1 = Math.min(pageH, view.y + view.h);
  const out = [];
  if (!(x1 > x0 && y1 > y0)) return out;
  const gx0 = Math.floor(x0 / tile) * tile;
  const gy0 = Math.floor(y0 / tile) * tile;
  for (let y = gy0; y < y1; y += tile) {
    for (let x = gx0; x < x1; x += tile) {
      const w = Math.min(tile, pageW - x);
      const h = Math.min(tile, pageH - y);
      if (w > 0 && h > 0) out.push({ x, y, w, h });
    }
  }
  return out;
}

export function renderTile(doc, index, zoom, x, y, w, h, token = 0) {
  checkPage(doc, index);
  const z = clampZoom(zoom);
  x = Math.round(Number(x));
  y = Math.round(Number(y));
  w = Math.round(Number(w));
  h = Math.round(Number(h));
  if (![x, y, w, h].every((n) => Number.isFinite(n)) || w < 1 || h < 1 || w > TILE_MAX || h > TILE_MAX || x < 0 || y < 0 || x > 40000 || y > 40000) {
    throw httpError(400, "Bad tile");
  }
  const id = docId(doc);
  const key = `${id}:${token}:${index}:${z}:${x}:${y}:${w}:${h}`;
  const hit = takeTile(key);
  if (hit) return hit;
  const dl = displayListFor(doc, index, token);
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [x, y, x + w, y + h], false);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  try {
    pix.clear(255);
    dl.run(dev, mupdf.Matrix.scale(z, z));
    dev.close();
    const png = Buffer.from(pix.asPNG());
    storeTile(id, token, key, png);
    return png;
  } finally {
    pix.destroy();
    dev.destroy();
  }
}

export function renderTiles(doc, index, zoom, view, token = 0, tile = VIEW_TILE) {
  const size = pagePixelSize(doc, index, zoom);
  const tiles = tilesCovering(size.width, size.height, view, tile);
  return tiles.map((t) => ({ ...t, png: renderTile(doc, index, size.zoom, t.x, t.y, t.w, t.h, token) }));
}

// ---------- annotations ----------

function annotId(a) {
  return a.getObject().asIndirect();
}

function stampLabel(a) {
  if (a.getType() !== "FreeText") return null;
  let subj = "";
  try {
    subj = a.getSubject();
  } catch {
    subj = "";
  }
  return subj && subj.startsWith(STAMP_PREFIX) ? subj.slice(STAMP_PREFIX.length) : null;
}

function kindOf(a) {
  const t = a.getType();
  if (t === "FreeText") {
    try { if (a.getIntent() === "FreeTextCallout") return "callout"; } catch {}
    return stampLabel(a) ? "stamp" : "text";
  }
  if (t === "Text") return "note";
  if (t === "Ink") return "pen";
  if (t === "Square") {
    try { if (a.getBorderEffect() === "Cloudy") return "cloud"; } catch {}
    return "box";
  }
  if (t === "Polygon") {
    try { if (a.getIntent() === "PolygonDimension") return "measure-area"; } catch {}
    try { if (a.getBorderEffect() === "Cloudy") return "cloud"; } catch {}
    return "polygon";
  }
  if (t === "PolyLine") return "polyline";
  if (t === "Stamp") return "stamp";
  if (t === "Highlight") return "highlight";
  if (t === "Underline") return "underline";
  if (t === "StrikeOut") return "strikeout";
  if (t === "Line") {
    try {
      if (a.getIntent() === "LineDimension") return "measure-distance";
    } catch {}
    try {
      const s = a.getLineEndingStyles();
      if (s.end !== "None" || s.start !== "None") return "arrow";
    } catch {
      /* no ending styles */
    }
    return "line";
  }
  return t.toLowerCase();
}

function colorOf(a) {
  try {
    if (a.getType() === "FreeText") return a.getDefaultAppearance().color;
    return a.getColor();
  } catch {
    return [];
  }
}

function safeDate(fn) {
  try {
    const d = fn();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
  } catch {
    return null;
  }
}

function replyParent(a) {
  try {
    const irt = a.getObject().get("IRT");
    if (irt && !irt.isNull() && irt.isIndirect()) return irt.asIndirect();
  } catch {}
  return null;
}

export function describeAnnot(a, pageIndex) {
  const b = a.getBounds();
  let author = "";
  try { author = a.getAuthor() || ""; } catch {}
  const out = {
    id: annotId(a),
    page: pageIndex,
    type: a.getType(),
    kind: kindOf(a),
    rect: b.map((v) => Math.round(v * 100) / 100),
    color: colorOf(a),
    contents: a.getContents() || "",
    author,
    created: safeDate(() => a.getCreationDate()),
    modified: safeDate(() => a.getModificationDate()),
  };
  const label = stampLabel(a);
  if (label) out.stamp = label;
  if (a.getType() === "Stamp") out.stamp = out.contents || "Custom stamp";
  const parent = replyParent(a);
  if (parent !== null) {
    out.kind = "reply";
    out.inReplyTo = parent;
  }
  return out;
}

/** Every annotation in the document, page by page, replies attached to their parent. */
export function listAllAnnots(doc) {
  const n = doc.countPages();
  const items = [];
  for (let i = 0; i < n; i++) items.push(...listAnnots(doc, i));
  const byId = new Map(items.map((a) => [a.id, a]));
  const top = [];
  for (const a of items) {
    if (a.inReplyTo !== undefined && byId.has(a.inReplyTo)) {
      const p = byId.get(a.inReplyTo);
      (p.replies ||= []).push(a);
    } else {
      top.push(a);
    }
  }
  // reading order on each page: top to bottom, then left to right
  top.sort((x, y) => x.page - y.page || x.rect[1] - y.rect[1] || x.rect[0] - y.rect[0]);
  for (const t of top) t.replies?.sort((x, y) => (x.created || "").localeCompare(y.created || ""));
  return top;
}

/** A reply is a hidden Text annotation linked to its parent with /IRT (what Acrobat does). */
export function replyToAnnot(doc, id, contents, author) {
  const f = findAnnot(doc, id);
  if (!f) throw httpError(404, "Annotation not found");
  const { page, annot: parent, index } = f;
  const r = parent.getRect();
  const a = page.createAnnotation("Text");
  a.setRect([r[0], r[1], r[0] + 20, r[1] + 20]);
  a.setIcon("Comment");
  a.setContents(String(contents ?? ""));
  a.getObject().put("IRT", parent.getObject());
  a.getObject().put("RT", doc.newName("R"));
  try { a.setAuthor(String(author || defaultAuthor)); } catch {}
  try { a.setCreationDate(new Date()); } catch {}
  try { a.setModificationDate(new Date()); } catch {}
  a.setFlags(PRINT | HIDDEN);
  a.update();
  return describeAnnot(a, index);
}

export function listAnnots(doc, index) {
  checkPage(doc, index);
  const page = doc.loadPage(index);
  return page
    .getAnnotations()
    .filter((a) => a.getType() !== "Popup" && a.getType() !== "Link")
    .map((a) => describeAnnot(a, index));
}

export function findAnnot(doc, id) {
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    for (const a of page.getAnnotations()) {
      if (annotId(a) === id) return { page, annot: a, index: i };
    }
  }
  return null;
}

const COLORS = {
  yellow: [1, 0.85, 0],
  red: [0.88, 0.02, 0],
  green: [0.1, 0.62, 0.2],
  blue: [0.1, 0.35, 0.95],
};

export function parseColor(c, fallback) {
  if (Array.isArray(c) && c.length === 3 && c.every((v) => Number.isFinite(v))) {
    return c.map((v) => Math.min(1, Math.max(0, v)));
  }
  if (typeof c === "string" && COLORS[c]) return COLORS[c];
  return COLORS[fallback] || COLORS.red;
}

function finish(a, author) {
  a.setFlags(PRINT);
  try {
    a.setAuthor(String(author || defaultAuthor));
  } catch {
    /* author not supported on this type */
  }
  try {
    a.setCreationDate(new Date());
  } catch {
    /* ignore */
  }
  try {
    a.setModificationDate(new Date());
  } catch {
    /* ignore */
  }
  a.update();
  return a;
}

function stampRect(label, cx, cy) {
  const size = 22;
  const w = Math.round(label.length * size * 0.66 + 30);
  const h = 36;
  return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
}

function pdfLatin(text) {
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

// Creates one annotation from image-space geometry.
// spec: { page, tool, zoom, rect?, point?, points?, from?, to?, color?, contents?, stamp? }
export function createAnnot(doc, spec) {
  const index = Number(spec.page);
  checkPage(doc, index);
  const page = doc.loadPage(index);
  const zoom = clampZoom(spec.zoom ?? 1);
  const tool = spec.tool;
  let a;
  switch (tool) {
    case "highlight":
    case "underline":
    case "strikeout": {
      const type = tool === "highlight" ? "Highlight" : tool === "underline" ? "Underline" : "StrikeOut";
      let quads;
      if (Array.isArray(spec.quads) && spec.quads.length) {
        // text-following markup: quads [ulx,uly,urx,ury,llx,lly,lrx,lry] in image space
        quads = spec.quads.map((q) => {
          if (!Array.isArray(q) || q.length !== 8) throw httpError(400, "Bad quad");
          const pts = [imgPt(page, zoom, [q[0], q[1]]), imgPt(page, zoom, [q[2], q[3]]), imgPt(page, zoom, [q[4], q[5]]), imgPt(page, zoom, [q[6], q[7]])];
          return [pts[0][0], pts[0][1], pts[1][0], pts[1][1], pts[2][0], pts[2][1], pts[3][0], pts[3][1]];
        });
      } else {
        if (tool !== "highlight") throw httpError(400, `${tool} needs text`);
        const r = imgRect(page, zoom, spec.rect);
        if (r[2] - r[0] < 1 || r[3] - r[1] < 1) throw httpError(400, "Highlight too small");
        quads = [[r[0], r[1], r[2], r[1], r[0], r[3], r[2], r[3]]];
      }
      a = page.createAnnotation(type);
      a.setColor(parseColor(spec.color, tool === "highlight" ? "yellow" : "red"));
      a.setQuadPoints(quads);
      if (spec.contents) a.setContents(String(spec.contents));
      break;
    }
    case "cloud": {
      // Rectangular or polygonal cloudy border (a standard PDF /BE /S /C annotation).
      const poly = Array.isArray(spec.points) && spec.points.length >= 3;
      a = page.createAnnotation(poly ? "Polygon" : "Square");
      a.setColor(parseColor(spec.color, "red"));
      a.setBorderWidth(Number(spec.width) || 2);
      a.setBorderEffect("Cloudy");
      a.setBorderEffectIntensity(Math.min(2, Math.max(0.5, Number(spec.intensity) || 1)));
      if (poly) {
        a.setVertices(spec.points.map((p) => imgPt(page, zoom, p)));
        a.setIntent("PolygonCloud");
      } else {
        const r = imgRect(page, zoom, spec.rect);
        if (r[2] - r[0] < 10 || r[3] - r[1] < 10) throw httpError(400, "Cloud too small");
        a.setRect(r);
      }
      if (spec.contents) a.setContents(String(spec.contents));
      break;
    }
    case "measure-distance": {
      const p = imgPt(page, zoom, spec.from);
      const q = imgPt(page, zoom, spec.to);
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 2) throw httpError(400, "Too short to measure");
      a = page.createAnnotation("Line");
      a.setColor(parseColor(spec.color, "red"));
      a.setBorderWidth(1);
      a.setLine(p, q);
      a.setIntent("LineDimension");
      a.setLineEndingStyles("OpenArrow", "OpenArrow");
      if (spec.contents) a.setContents(String(spec.contents));
      break;
    }
    case "measure-area": {
      const min = 3;
      if (!Array.isArray(spec.points) || spec.points.length < min) throw httpError(400, `area needs ${min} points`);
      a = page.createAnnotation("Polygon");
      a.setVertices(spec.points.map((pt) => imgPt(page, zoom, pt)));
      a.setColor(parseColor(spec.color, "red"));
      a.setBorderWidth(1);
      a.setIntent("PolygonDimension");
      if (spec.contents) a.setContents(String(spec.contents));
      break;
    }
    case "polygon":
    case "polyline": {
      const min = tool === "polygon" ? 3 : 2;
      if (!Array.isArray(spec.points) || spec.points.length < min) throw httpError(400, `${tool} needs ${min} points`);
      a = page.createAnnotation(tool === "polygon" ? "Polygon" : "PolyLine");
      a.setVertices(spec.points.map((p) => imgPt(page, zoom, p)));
      a.setColor(parseColor(spec.color, "red"));
      a.setBorderWidth(Number(spec.width) || 2);
      if (spec.contents) a.setContents(String(spec.contents));
      break;
    }
    case "callout": {
      const r = imgRect(page, zoom, spec.rect);
      const tip = imgPt(page, zoom, spec.point);
      if (r[2] - r[0] < 20 || r[3] - r[1] < 12) throw httpError(400, "Callout too small");
      a = page.createAnnotation("FreeText");
      a.setRect(r);
      a.setContents(String(spec.contents || ""));
      a.setDefaultAppearance("Helv", Number(spec.fontSize) || 12, parseColor(spec.color, "red"));
      a.setBorderWidth(1);
      a.setColor(parseColor(spec.color, "red"));
      a.setIntent("FreeTextCallout");
      const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
      const edge = [tip[0] < cx ? r[0] : r[2], Math.max(r[1], Math.min(r[3], tip[1]))];
      const elbow = [tip[0] + (edge[0] - tip[0]) * 0.65, edge[1]];
      a.setCalloutLine([tip, elbow, edge]);
      a.setCalloutStyle("OpenArrow");
      break;
    }
    case "custom-stamp": {
      const r = imgRect(page, zoom, spec.rect);
      const label = String(spec.label || "").trim().slice(0, 100);
      if (!label) throw httpError(400, "Stamp text required");
      if (r[2] - r[0] < 20 || r[3] - r[1] < 15) throw httpError(400, "Stamp too small");
      a = page.createAnnotation("Stamp");
      a.setRect(r);
      a.setContents(label);
      const w = r[2] - r[0], h = r[3] - r[1];
      const col = parseColor(spec.color, "red");
      const font = new mupdf.Font("Helvetica-Bold");
      const fontRef = doc.addSimpleFont(font, "Latin");
      const size = Math.min(h * 0.45, Math.max(8, (w - 16) / Math.max(1, label.length * 0.63)));
      const color = col.join(" ");
      const msg = pdfLatin(label);
      const cs = `q ${color} RG 2 w 2 2 ${w - 4} ${h - 4} re S Q BT /F1 ${size.toFixed(2)} Tf ${color} rg 8 ${(h - size) / 2} Td (${msg}) Tj ET`;
      a.setAppearance("N", null, mupdf.Matrix.identity, [0, 0, w, h], { Font: { F1: fontRef } }, Buffer.from(cs, "latin1"));
      break;
    }
    case "image-stamp": {
      const r = imgRect(page, zoom, spec.rect);
      if (r[2] - r[0] < 10 || r[3] - r[1] < 10) throw httpError(400, "Stamp too small");
      if (!spec.imageBytes) throw httpError(400, "Image required");
      const im = new mupdf.Image(spec.imageBytes);
      a = page.createAnnotation("Stamp");
      a.setRect(r);
      a.setStampImage(im);
      a.setContents(String(spec.label || "Image stamp"));
      break;
    }
    case "note": {
      const [x, y] = imgPt(page, zoom, spec.point);
      a = page.createAnnotation("Text");
      a.setRect([x, y, x + 20, y + 20]);
      a.setIcon("Comment");
      a.setColor(parseColor(spec.color, "yellow"));
      a.setContents(String(spec.contents ?? ""));
      break;
    }
    case "text": {
      const r = imgRect(page, zoom, spec.rect);
      if (r[2] - r[0] < 8 || r[3] - r[1] < 8) throw httpError(400, "Text box too small");
      a = page.createAnnotation("FreeText");
      a.setRect(r);
      a.setContents(String(spec.contents ?? ""));
      a.setDefaultAppearance("Helv", Number(spec.fontSize) || 12, parseColor(spec.color, "red"));
      a.setBorderWidth(1);
      break;
    }
    case "pen": {
      const strokes = Array.isArray(spec.points?.[0]?.[0]) ? spec.points : [spec.points];
      const ink = strokes
        .filter((s) => Array.isArray(s) && s.length >= 2)
        .map((s) => s.map((p) => imgPt(page, zoom, p)));
      if (!ink.length) throw httpError(400, "Pen stroke needs at least two points");
      a = page.createAnnotation("Ink");
      a.setColor(parseColor(spec.color, "red"));
      a.setBorderWidth(Number(spec.width) || 2);
      a.setInkList(ink);
      break;
    }
    case "line":
    case "arrow": {
      const p = imgPt(page, zoom, spec.from);
      const q = imgPt(page, zoom, spec.to);
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 2) throw httpError(400, "Line too short");
      a = page.createAnnotation("Line");
      const col = parseColor(spec.color, "red");
      a.setColor(col);
      a.setBorderWidth(Number(spec.width) || 2);
      a.setLine(p, q);
      if (tool === "arrow") {
        a.setLineEndingStyles("None", "ClosedArrow");
        a.setInteriorColor(col);
      }
      break;
    }
    case "box": {
      const r = imgRect(page, zoom, spec.rect);
      if (r[2] - r[0] < 2 || r[3] - r[1] < 2) throw httpError(400, "Box too small");
      a = page.createAnnotation("Square");
      a.setRect(r);
      a.setColor(parseColor(spec.color, "red"));
      a.setBorderWidth(Number(spec.width) || 2);
      break;
    }
    case "stamp": {
      const label = String(spec.stamp || "").toUpperCase();
      if (!STAMPS.includes(label)) throw httpError(400, `Unknown stamp ${spec.stamp}`);
      const [x, y] = imgPt(page, zoom, spec.point);
      a = page.createAnnotation("FreeText");
      a.setRect(stampRect(label, x, y));
      a.setContents(label);
      a.setSubject(STAMP_PREFIX + label);
      a.setDefaultAppearance("Helv", 22, COLORS.red);
      a.setBorderWidth(3);
      a.setQuadding(1);
      break;
    }
    default:
      throw httpError(400, `Unknown tool ${tool}`);
  }
  finish(a, spec.author);
  if (tool === "note") {
    // Note icons do not rotate with the page, so on a rotated page the icon is drawn
    // from a different corner of /Rect. Shift it so the icon sits at the pointer.
    const [x, y] = imgPt(page, zoom, spec.point);
    const b = a.getBounds();
    const dx = x - b[0];
    const dy = y - b[1];
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      const r = a.getRect();
      a.setRect([r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]);
      a.update();
    }
  }
  return describeAnnot(a, index);
}

// Raw helper used by tests: a square given directly in PDF user space.
export function addSquareUser(doc, index, userRect, color = [1, 0, 0], fill = true) {
  const page = doc.loadPage(index);
  const a = page.createAnnotation("Square");
  a.setRect(userRectToPage(page, userRect));
  a.setColor(color);
  if (fill) a.setInteriorColor(color);
  a.setBorderWidth(1);
  finish(a);
  return describeAnnot(a, index);
}

export function rawUserRect(doc, id) {
  const f = findAnnot(doc, id);
  if (!f) return null;
  return f.annot.getObject().get("Rect").asJS();
}

// patch: { dx, dy, zoom } in image pixels, and/or { contents }
export function patchAnnot(doc, id, patch) {
  const f = findAnnot(doc, id);
  if (!f) throw httpError(404, "Annotation not found");
  const { annot: a, page, index } = f;
  const zoom = clampZoom(patch.zoom ?? 1);
  if (patch.dx || patch.dy) {
    // a translation in image space maps to a translation in page space
    const o = imgPt(page, zoom, [0, 0]);
    const d = imgPt(page, zoom, [Number(patch.dx) || 0, Number(patch.dy) || 0]);
    const dx = d[0] - o[0];
    const dy = d[1] - o[1];
    const t = a.getType();
    if (t === "Highlight" || t === "Underline" || t === "StrikeOut" || t === "Squiggly") {
      a.setQuadPoints(a.getQuadPoints().map((q) => q.map((v, i) => v + (i % 2 ? dy : dx))));
    } else if (t === "Ink") {
      a.setInkList(a.getInkList().map((s) => s.map(([x, y]) => [x + dx, y + dy])));
    } else if (t === "Polygon" || t === "PolyLine") {
      a.setVertices(a.getVertices().map(([x, y]) => [x + dx, y + dy]));
    } else if (t === "FreeText" && kindOf(a) === "callout") {
      a.setRect(a.getRect().map((v, i) => v + (i % 2 ? dy : dx)));
      const raw = a.getObject().get("CL");
      if (raw && raw.isArray() && raw.length >= 4) {
        const pts = [];
        for (let i = 0; i + 1 < raw.length; i += 2) pts.push(userPointToPage(page, [raw.get(i).asNumber(), raw.get(i + 1).asNumber()]));
        a.setCalloutLine(pts.map(([x, y]) => [x + dx, y + dy]));
      }
    } else if (t === "Line") {
      const [p, q] = a.getLine();
      a.setLine([p[0] + dx, p[1] + dy], [q[0] + dx, q[1] + dy]);
    } else {
      const r = a.getRect();
      a.setRect([r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]);
    }
  }
  if (typeof patch.contents === "string" && !stampLabel(a)) {
    a.setContents(patch.contents);
  }
  if (patch.color !== undefined && !stampLabel(a)) {
    const c = parseColor(patch.color, "red");
    if (a.getType() === "FreeText") {
      const da = a.getDefaultAppearance();
      a.setDefaultAppearance(da.font || "Helv", da.size || 12, c);
    } else {
      a.setColor(c);
      if (a.getType() === "Line" && kindOf(a) === "arrow") a.setInteriorColor(c);
    }
  }
  a.setModificationDate(new Date());
  a.update();
  return describeAnnot(a, index);
}

export function deleteAnnot(doc, id) {
  const f = findAnnot(doc, id);
  if (!f) throw httpError(404, "Annotation not found");
  // replies go with their parent (collect first: deleting while iterating skips entries)
  const replies = f.page.getAnnotations().filter((r) => replyParent(r) === id);
  for (const r of replies) f.page.deleteAnnotation(r);
  f.page.deleteAnnotation(f.annot);
  return { id, page: f.index };
}

// ---------- pages ----------

export function getRotate(doc, index) {
  const obj = doc.loadPage(index).getObject();
  const r = obj.getInheritable("Rotate");
  const n = r && !r.isNull() ? r.asNumber() : 0;
  return ((n % 360) + 360) % 360;
}

export function rotatePage(doc, index, delta) {
  checkPage(doc, index);
  const d = Number(delta);
  if (d !== 90 && d !== -90 && d !== 180) throw httpError(400, "delta must be 90 or -90");
  const next = (((getRotate(doc, index) + d) % 360) + 360) % 360;
  doc.loadPage(index).getObject().put("Rotate", next);
  return next;
}

export function deletePage(doc, index) {
  checkPage(doc, index);
  if (doc.countPages() <= 1) throw httpError(400, "Cannot delete the only page");
  doc.deletePage(index);
}

export function movePage(doc, from, to) {
  checkPage(doc, from);
  checkPage(doc, to);
  if (from === to) return;
  const n = doc.countPages();
  const order = [...Array(n).keys()];
  order.splice(from, 1);
  order.splice(to, 0, from);
  doc.rearrangePages(order);
}

export function insertBlankPage(doc, at, likeIndex) {
  const n = doc.countPages();
  const pos = Math.max(0, Math.min(n, Number.isInteger(at) ? at : n));
  let w = 612;
  let h = 792;
  if (n > 0) {
    const ref = Math.max(0, Math.min(n - 1, Number.isInteger(likeIndex) ? likeIndex : pos - 1));
    const b = doc.loadPage(ref).getBounds();
    w = b[2] - b[0];
    h = b[3] - b[1];
  }
  doc.insertPage(pos, doc.addPage([0, 0, w, h], 0, {}, " "));
  return pos;
}

// ---------- text map (for selection) ----------

/**
 * Every character on a page with its quad in page space (points, origin top-left, y down),
 * grouped by line in reading order. The client scales by zoom. Spaces between words are kept.
 */
export function textMap(doc, index) {
  checkPage(doc, index);
  const page = doc.loadPage(index);
  const stext = page.toStructuredText("preserve-whitespace");
  const lines = [];
  let cur = null;
  const r3 = (v) => Math.round(v * 100) / 100;
  stext.walk({
    beginLine(bbox, wmode, dir) {
      cur = { bbox: bbox.map(r3), dir: [r3(dir[0]), r3(dir[1])], chars: [] };
    },
    onChar(c, origin, font, size, quad) {
      if (!cur) return;
      cur.chars.push({ c, q: Array.from(quad).map(r3) });
    },
    endLine() {
      if (cur && cur.chars.some((ch) => ch.c.trim())) lines.push(cur);
      cur = null;
    },
  });
  return { page: index, lines };
}

// ---------- combine / insert / extract / split ----------

/**
 * Parse a page range like "1-3, 5, 8-" (1-based, inclusive) into 0-based indices, in order,
 * without duplicates. "all" or "" -> every page.
 */
export function parsePageRange(text, pageCount) {
  const n = Number(pageCount);
  const t = String(text ?? "").trim().toLowerCase();
  if (!t || t === "all") return [...Array(n).keys()];
  const out = [];
  const seen = new Set();
  for (const part of t.split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)?(?:-(\d+)?)?$/);
    if (!m || (m[1] === undefined && m[2] === undefined)) throw httpError(400, `Bad page range "${part}"`);
    let a = m[1] !== undefined ? Number(m[1]) : 1;
    let b = part.includes("-") ? (m[2] !== undefined ? Number(m[2]) : n) : a;
    if (a < 1 || b > n || a > b) throw httpError(400, `Page range "${part}" is outside 1-${n}`);
    for (let i = a - 1; i <= b - 1; i++) if (!seen.has(i)) { seen.add(i); out.push(i); }
  }
  return out;
}

export function isImageBytes(bytes) {
  if (!bytes || bytes.length < 12) return false;
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00)) return "tiff";
  if (b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  return false;
}

/**
 * Open bytes as a document to take pages from: a PDF, or an image which becomes a one-page
 * PDF sized to the image at its own resolution (72 dpi if unknown), like Acrobat's
 * "Create from image". Images wider than tall get a landscape page.
 */
export function openSource(bytes) {
  if (isPdfBytes(bytes)) return openBytes(bytes);
  if (!isImageBytes(bytes)) throw httpError(400, "Not a PDF or an image (JPEG, PNG, TIFF, BMP, GIF)");
  const img = new mupdf.Image(bytes);
  const doc = new mupdf.PDFDocument();
  const ref = doc.addImage(img);
  const xres = img.getXResolution() || 72;
  const yres = img.getYResolution() || 72;
  let w = (img.getWidth() * 72) / Math.max(36, xres);
  let h = (img.getHeight() * 72) / Math.max(36, yres);
  // Odd or missing resolution gives silly pages: fit those to Letter (landscape if wider).
  if (Math.min(w, h) < 144 || Math.max(w, h) > 60 * 72) {
    const land = img.getWidth() > img.getHeight();
    const pw = land ? 792 : 612, ph = land ? 612 : 792;
    const s = Math.min((pw - 72) / img.getWidth(), (ph - 72) / img.getHeight());
    w = img.getWidth() * s;
    h = img.getHeight() * s;
  }
  const res = doc.addObject({ XObject: { Im0: ref } });
  doc.insertPage(-1, doc.addPage([0, 0, w, h], 0, res, `q ${w.toFixed(3)} 0 0 ${h.toFixed(3)} 0 0 cm /Im0 Do Q`));
  return doc;
}

/**
 * Insert pages from another document into doc at position `at` (0..countPages). `pages` are
 * 0-based indices of src (default all). Returns the number inserted.
 */
export function insertPagesFrom(doc, src, at, pages) {
  const n = doc.countPages();
  let pos = Number.isInteger(at) ? Math.max(0, Math.min(n, at)) : n;
  const list = pages ?? [...Array(src.countPages()).keys()];
  for (const i of list) {
    if (i < 0 || i >= src.countPages()) throw httpError(400, `Source has no page ${i + 1}`);
    doc.graftPage(pos, src, i);
    pos++;
  }
  return list.length;
}

/** A new document holding copies of the given pages of doc, in that order. */
export function extractPages(doc, pages) {
  const out = new mupdf.PDFDocument();
  for (const i of pages) {
    checkPage(doc, i);
    out.graftPage(-1, doc, i);
  }
  return out;
}

/** Delete several pages at once (any order). Refuses to empty the document. */
export function deletePages(doc, pages) {
  const uniq = [...new Set(pages)].sort((a, b) => b - a);
  if (uniq.length >= doc.countPages()) throw httpError(400, "Cannot delete every page");
  for (const i of uniq) {
    checkPage(doc, i);
    doc.deletePage(i);
  }
  return uniq.length;
}

/**
 * Split plan: chunks of page indices. mode "every" = N pages per file; "ranges" = explicit
 * list like "1-3, 4-6"; "each" = one page per file.
 */
export function splitPlan(doc, { mode = "every", every = 1, ranges = "" } = {}) {
  const n = doc.countPages();
  if (mode === "each") return [...Array(n).keys()].map((i) => [i]);
  if (mode === "ranges") {
    const parts = String(ranges).split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) throw httpError(400, "No ranges given");
    return parts.map((p) => parsePageRange(p, n));
  }
  const k = Math.max(1, Number(every) | 0);
  const chunks = [];
  for (let i = 0; i < n; i += k) chunks.push([...Array(Math.min(k, n - i)).keys()].map((j) => i + j));
  return chunks;
}

// ---------- comment summary export ----------

const KIND_LABEL = { cloud: "Revision cloud", callout: "Callout", polygon: "Polygon", polyline: "Polyline", highlight: "Highlight", underline: "Underline", strikeout: "Strikeout", note: "Note", text: "Text box", pen: "Pen", line: "Line", arrow: "Arrow", box: "Box", stamp: "Stamp", reply: "Reply" };

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function annotsToCsv(doc, name = "") {
  const rows = [["File", "Page", "Type", "Author", "Date", "Comment", "Reply to"]];
  for (const a of listAllAnnots(doc)) {
    const text = a.stamp ? `${a.stamp}` : a.contents;
    rows.push([name, a.page + 1, KIND_LABEL[a.kind] || a.kind, a.author, fmtDate(a.modified || a.created), text, ""]);
    for (const r of a.replies || []) rows.push([name, r.page + 1, "Reply", r.author, fmtDate(r.modified || r.created), r.contents, text.slice(0, 40)]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function wrap(text, max) {
  const out = [];
  for (const para of String(text).split(/\r?\n/)) {
    let line = "";
    for (const w of para.split(/\s+/)) {
      if (!w) continue;
      if ((line + " " + w).trim().length > max) { if (line) out.push(line); line = w; }
      else line = (line + " " + w).trim();
    }
    out.push(line);
  }
  return out;
}

function pdfStr(s) {
  return "(" + encodeLatinText(s) + ")";
}

function encodeLatinText(text) {
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

/** A printable summary PDF: one section per page listing every comment with author and date. */
export function annotsSummaryPdf(doc, name = "") {
  const out = new mupdf.PDFDocument();
  const font = out.addSimpleFont(new mupdf.Font("Helvetica"), "Latin");
  const bold = out.addSimpleFont(new mupdf.Font("Helvetica-Bold"), "Latin");
  const res = out.addObject({ Font: { F1: font, F2: bold } });
  const W = 612, H = 792, M = 54, LH = 14;
  let lines = []; // [text, bold, indent]
  const all = listAllAnnots(doc);
  lines.push([`Comment summary — ${name || "document"}`, true, 0]);
  lines.push([`${all.length} comment${all.length === 1 ? "" : "s"} · exported ${fmtDate(new Date().toISOString())}`, false, 0]);
  lines.push(["", false, 0]);
  let lastPage = -1;
  for (const a of all) {
    if (a.page !== lastPage) {
      if (lastPage >= 0) lines.push(["", false, 0]);
      lines.push([`Page ${a.page + 1}`, true, 0]);
      lastPage = a.page;
    }
    const head = `${KIND_LABEL[a.kind] || a.kind} · ${a.author || "—"} · ${fmtDate(a.modified || a.created)}`;
    lines.push([head, true, 12]);
    const body = a.stamp ? a.stamp : a.contents;
    if (body) for (const l of wrap(body, 88)) lines.push([l, false, 24]);
    for (const r of a.replies || []) {
      lines.push([`Reply · ${r.author || "—"} · ${fmtDate(r.modified || r.created)}`, true, 36]);
      for (const l of wrap(r.contents, 80)) lines.push([l, false, 48]);
    }
  }
  if (!all.length) lines.push(["No comments.", false, 0]);
  const perPage = Math.floor((H - 2 * M) / LH);
  for (let p = 0; p * perPage < lines.length; p++) {
    const chunk = lines.slice(p * perPage, (p + 1) * perPage);
    let cs = "BT\n";
    chunk.forEach(([t, b, ind], i) => {
      const y = H - M - i * LH;
      cs += `/${b ? "F2" : "F1"} ${b && ind === 0 ? 12 : 10} Tf 1 0 0 1 ${M + ind} ${y} Tm ${pdfStr(t)} Tj\n`;
    });
    cs += `/F1 8 Tf 1 0 0 1 ${W - M - 40} ${M / 2} Tm ${pdfStr(`${p + 1}`)} Tj\nET`;
    // latin1 bytes: the strings are WinAnsi-encoded, a JS string would be written as UTF-8
    out.insertPage(-1, out.addPage([0, 0, W, H], 0, res, Buffer.from(cs, "latin1")));
  }
  return out;
}

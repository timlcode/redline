import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { PNG } from "pngjs";
import * as mupdf from "mupdf";
import * as P from "../lib/pdf.mjs";
import * as R from "../lib/redact.mjs";
import * as O from "../lib/ocrdoc.mjs";
import { writeTextLayer } from "../lib/textlayer.mjs";
import { createServer } from "../server.mjs";

const SECRET = "PAGE-TOKEN-ALPHA";
const KEEP = "KEEP-VISIBLE-LINE";
const NOTE = "NOTE-TOKEN-GAMMA";
const NOTE_OUT = "NOTE-OUTSIDE-KEEP";
const FIELD = "FIELD-TOKEN-DELTA";
const OCR = "OCR-TOKEN-BETA";
const META = "META-TOKEN-EPSILON";
const FILETOK = "FILE-TOKEN-ZETA";
const JSTOK = "JS-TOKEN-ETA";
const HIDDEN = "HIDDEN-TOKEN-IOTA";
const PHONE = "(555) 010-0199";
const PHONE2 = "555-010-0142";
const EMAIL = "desk@example.com";
const SSN = "987-65-4321";
const MONEY = "$4,815.00";

function textOp(x, y, text, size = 16) {
  const esc = String(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  return `BT /F1 ${size} Tf 0 0 0 rg 1 0 0 1 ${x} ${y} Tm (${esc}) Tj ET\n`;
}

function userRectToPage(page, rect) {
  return P.userRectToPage(page, rect);
}

function buildFixture() {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const png = new PNG({ width: 80, height: 40 });
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 80; x++) {
      const i = (y * 80 + x) * 4;
      const left = x < 40;
      png.data[i] = left ? 255 : 0;
      png.data[i + 1] = 0;
      png.data[i + 2] = left ? 0 : 255;
      png.data[i + 3] = 255;
    }
  }
  const image = new mupdf.Image(PNG.sync.write(png));
  const im = doc.addImage(image);
  const res = doc.addObject({ Font: { F1: font }, XObject: { Im0: im } });
  const body = [
    textOp(72, 700, SECRET),
    textOp(72, 660, KEEP),
    textOp(72, 620, PHONE),
    textOp(72, 590, EMAIL),
    textOp(72, 560, SSN),
    textOp(72, 530, MONEY),
    textOp(72, 500, "see the change order log"),
    "q 160 0 0 80 72 300 cm /Im0 Do Q\n",
    "q 0 0.75 0 rg 72 240 80 28 re f Q\n",
    "q 0 0 0.8 rg 400 240 40 28 re f Q\n",
  ].join("");
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, body));
  const page2res = doc.addObject({ Font: { F1: font } });
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, page2res, textOp(72, 700, PHONE2)));

  const page = doc.loadPage(0);
  const ocg = doc.addObject({ Type: "OCG", Name: "Notes off" });
  doc.getTrailer().get("Root").put("OCProperties", {
    OCGs: [ocg],
    D: { OFF: [ocg], Order: [ocg], ON: [] },
  });
  let pres = page.getObject().get("Resources");
  pres.put("Properties", doc.addObject({ Hidden: ocg }));
  const extra = Buffer.from(`/OC /Hidden BDC\n${textOp(72, 80, HIDDEN, 12)}EMC\n`, "latin1");
  const contents = page.getObject().get("Contents");
  const prev = Buffer.from(contents.readStream().asUint8Array());
  contents.writeStream(Buffer.concat([prev, extra]));

  doc.setMetaData("info:Title", META);
  doc.setMetaData("info:Author", "Desk");
  const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta><rdf:RDF><rdf:Description>${META}</rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`;
  const meta = doc.addStream(Buffer.from(xmp), { Type: "Metadata", Subtype: "XML" });
  doc.getTrailer().get("Root").put("Metadata", meta);

  doc.addEmbeddedFile("note.txt", "text/plain", Buffer.from(FILETOK), new Date("2020-01-01"), new Date("2020-01-02"));
  const js = doc.addObject({ S: "JavaScript", JS: `(app.alert('${JSTOK}');)` });
  doc.getTrailer().get("Root").put("OpenAction", js);

  const form = doc.addObject({
    Fields: [],
    DA: "(/Helv 9 Tf 0 g)",
    DR: { Font: { Helv: font } },
  });
  doc.getTrailer().get("Root").put("AcroForm", form);
  const widget = page.createAnnotation("Widget");
  const fieldUser = [300, 680, 480, 704];
  widget.setRect(userRectToPage(page, fieldUser));
  const wo = widget.getObject();
  wo.put("FT", "Tx");
  wo.put("T", "(JobCode)");
  wo.put("V", `(${FIELD})`);
  wo.put("DA", "(/Helv 9 Tf 0 g)");
  wo.put("F", 4);
  form.get("Fields").push(wo);
  widget.update();

  const note = page.createAnnotation("Text");
  const secretRect = page.search(SECRET)[0][0];
  const sb = bounds(secretRect);
  note.setRect([sb[0], sb[1], sb[0] + 18, sb[1] + 18]);
  note.setContents(NOTE);
  note.update();

  const outside = page.createAnnotation("Text");
  outside.setRect([400, 400, 420, 420]);
  outside.setContents(NOTE_OUT);
  outside.update();

  writeTextLayer(doc, 0, [{
    text: OCR,
    box: [[72, 150], [260, 150], [260, 170], [72, 170]],
  }], 1);

  const dest = doc.formatLinkURI({ type: "XYZ", chapter: 0, page: 0, x: 90, y: 708, width: 0, height: 0, zoom: 0 });
  page.createLink([20, 200, 80, 216], dest);
  const keepDest = doc.formatLinkURI({ type: "XYZ", chapter: 0, page: 0, x: 90, y: 668, width: 0, height: 0, zoom: 0 });
  const it = doc.outlineIterator();
  it.insert({ title: "Marked spot", uri: dest, page: 0 });
  it.insert({ title: "Kept spot", uri: keepDest, page: 0 });

  return doc;
}

function bounds(q) {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function allText(doc) {
  let out = "";
  for (let i = 0; i < doc.countPages(); i++) {
    out += doc.loadPage(i).toStructuredText("preserve-whitespace").asText();
    out += "\n";
    out += O.pageText(doc, i);
    out += "\n";
    const map = P.textMap(doc, i);
    out += map.lines.map((ln) => ln.chars.map((c) => c.c).join("")).join("\n");
    out += "\n";
  }
  return out;
}

function assertAbsent(doc, bytes, token) {
  const text = allText(doc);
  assert.ok(!text.includes(token), `extracted text still has ${token}`);
  for (let i = 0; i < doc.countPages(); i++) {
    assert.equal(doc.loadPage(i).search(token).length, 0, `search still finds ${token}`);
  }
  assert.equal(R.pdfContains(bytes, token), false, `file bytes still contain ${token}`);
}

function sample(doc, x, y) {
  const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
  const w = pix.getWidth();
  const px = pix.getPixels();
  const i = (Math.round(y) * w + Math.round(x)) * pix.getNumberOfComponents();
  const rgb = [px[i], px[i + 1], px[i + 2]];
  pix.destroy();
  return rgb;
}

function imagePixels(doc) {
  const found = [];
  const walk = (obj) => {
    if (!obj || obj.isNull() || !obj.isDictionary()) return;
    obj.forEach((val) => {
      try {
        const sub = val.get("Subtype");
        const name = sub && sub.isName() ? sub.asName() : "";
        if (name !== "Image") return;
        const im = doc.loadImage(val);
        const pix = im.toPixmap();
        found.push({ w: pix.getWidth(), h: pix.getHeight(), pix });
      } catch { /* not an image */ }
    });
  };
  for (let i = 0; i < doc.countPages(); i++) {
    const res = doc.loadPage(i).getObject().get("Resources");
    if (res && res.get("XObject")) walk(res.get("XObject"));
  }
  return found;
}

function countRed(pix) {
  const px = pix.getPixels();
  const comps = pix.getNumberOfComponents();
  const stride = pix.getStride();
  let n = 0;
  for (let y = 0; y < pix.getHeight(); y++) {
    for (let x = 0; x < pix.getWidth(); x++) {
      const i = y * stride + x * comps;
      if (px[i] > 200 && px[i + 1] < 40 && px[i + 2] < 40) n++;
    }
  }
  return n;
}

function countBlue(pix) {
  const px = pix.getPixels();
  const comps = pix.getNumberOfComponents();
  const stride = pix.getStride();
  let n = 0;
  for (let y = 0; y < pix.getHeight(); y++) {
    for (let x = 0; x < pix.getWidth(); x++) {
      const i = y * stride + x * comps;
      if (px[i + 2] > 200 && px[i] < 40 && px[i + 1] < 40) n++;
    }
  }
  return n;
}

function markText(doc, token, page = 0) {
  const hits = doc.loadPage(page).search(token);
  assert.ok(hits.length, `fixture missing ${token}`);
  for (const quads of hits) {
    R.addMark(doc, { page, space: "page", quads: quads.map((q) => Array.from(q)), label: token, color: "black" });
  }
}

test("search lists pattern hits on every page and can reject one", () => {
  const doc = buildFixture();
  const phones = R.searchRedactions(doc, { pattern: "phone" });
  assert.equal(phones.total, 2);
  assert.deepEqual(phones.hits.map((h) => h.page).sort(), [0, 1]);
  const emails = R.searchRedactions(doc, { pattern: "email" });
  assert.equal(emails.hits[0].text, EMAIL);
  const ssns = R.searchRedactions(doc, { pattern: "ssn" });
  assert.equal(ssns.hits[0].text, SSN);
  const money = R.searchRedactions(doc, { pattern: "money" });
  assert.equal(money.hits[0].text, MONEY);
  const phrase = R.searchRedactions(doc, { query: "change order" });
  assert.equal(phrase.total, 1);
  const accepted = phrase.hits.slice(0, 0);
  assert.equal(accepted.length, 0);
  assert.equal(R.listMarks(doc).length, 0);
});

test("applying redactions deletes text, vectors, image pixels, fields, and notes", () => {
  const doc = buildFixture();
  const before = allText(doc);
  for (const token of [SECRET, KEEP, PHONE, EMAIL, SSN, OCR]) assert.ok(before.includes(token), token);

  markText(doc, SECRET);
  markText(doc, PHONE);
  markText(doc, PHONE2, 1);
  markText(doc, EMAIL);
  markText(doc, SSN);
  markText(doc, MONEY);
  markText(doc, "change order");
  markText(doc, OCR);

  const page = doc.loadPage(0);
  const img = userRectToPage(page, [72, 300, 152, 380]);
  R.addMark(doc, { page: 0, space: "page", rect: img, color: "black", label: "Area" });
  const vec = userRectToPage(page, [72, 240, 152, 268]);
  R.addMark(doc, { page: 0, space: "page", rect: vec, color: "black", label: "Area" });
  const field = userRectToPage(page, [300, 680, 480, 704]);
  R.addMark(doc, { page: 0, space: "page", rect: field, color: [0.8, 0, 0], overlay: "REDACTED", label: "Area" });

  assert.ok(R.listMarks(doc).length >= 8);
  const preview = sample(doc, (img[0] + img[2]) / 2, (img[1] + img[3]) / 2);
  assert.ok(preview[0] < 30 && preview[1] < 30 && preview[2] < 30, `mark preview ${preview}`);

  const applied = R.applyRedactions(doc, { sanitize: true });
  assert.ok(applied.applied >= 8);
  assert.equal(applied.sanitized, true);
  const bytes = P.saveBytes(doc, null, { rewrite: true });
  const out = P.openBytes(new Uint8Array(bytes));

  for (const token of [SECRET, PHONE, PHONE2, EMAIL, SSN, MONEY, OCR, NOTE, FIELD, HIDDEN, META, FILETOK, JSTOK]) {
    assertAbsent(out, bytes, token);
  }
  assert.ok(allText(out).includes(KEEP), "text outside the marks must remain");
  assert.equal(out.loadPage(0).search("change order").length, 0);
  assert.ok(!allText(out).includes("change order"));

  const images = imagePixels(out);
  assert.ok(images.length >= 1);
  const reds = images.reduce((n, im) => n + countRed(im.pix), 0);
  const blues = images.reduce((n, im) => n + countBlue(im.pix), 0);
  for (const im of images) im.pix.destroy();
  assert.equal(reds, 0, "red pixels under the box must be gone from the image");
  assert.ok(blues > 20, "image pixels outside the box must remain");

  const left = sample(out, (img[0] + img[2]) / 2, (img[1] + img[3]) / 2);
  const rightUser = userRectToPage(out.loadPage(0), [190, 300, 230, 380]);
  const right = sample(out, (rightUser[0] + rightUser[2]) / 2, (rightUser[1] + rightUser[3]) / 2);
  assert.ok(left[0] < 40 && left[1] < 40 && left[2] < 40, `redacted image area ${left}`);
  assert.ok(right[2] > 180 && right[0] < 40, `kept image area ${right}`);

  const green = sample(out, (vec[0] + vec[2]) / 2, (vec[1] + vec[3]) / 2);
  assert.ok(green[1] < 40, `vector under the box ${green}`);
  const keepVec = userRectToPage(out.loadPage(0), [400, 240, 440, 268]);
  const blue = sample(out, (keepVec[0] + keepVec[2]) / 2, (keepVec[1] + keepVec[3]) / 2);
  assert.ok(blue[2] > 150 && blue[0] < 40, `vector outside the box ${blue}`);

  const overlay = allText(out);
  assert.ok(overlay.includes("REDACTED"));
  const fieldPage = userRectToPage(out.loadPage(0), [300, 680, 480, 704]);
  const redBox = sample(out, (fieldPage[0] + fieldPage[2]) / 2, (fieldPage[1] + fieldPage[3]) / 2);
  assert.ok(redBox[0] > 160 && redBox[1] < 50, `custom redaction color ${redBox}`);

  assert.equal(out.getMetaData("info:Title") || "", "");
  assert.equal(out.getMetaData("info:Author") || "", "");
  const xmp = out.getTrailer().get("Root").get("Metadata");
  assert.ok(!xmp || xmp.isNull());
  assert.deepEqual(out.getEmbeddedFiles(), {});
  assert.equal(out.countVersions(), 1);
  assert.equal((bytes.toString("latin1").match(/startxref/g) || []).length, 1);
  const outline = out.loadOutline() || [];
  assert.ok(!outline.some((item) => item.title === "Marked spot"));
  assert.ok(outline.some((item) => item.title === "Kept spot"));
  assert.equal(out.loadPage(0).getAnnotations().some((a) => (a.getContents() || "").includes(NOTE_OUT)), false);
});

test("a full rewrite drops text that lived only in an older incremental revision", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-rev-"));
  try {
    const base = new mupdf.PDFDocument();
    const font = base.addSimpleFont(new mupdf.Font("Helvetica"));
    const res = base.addObject({ Font: { F1: font } });
    base.insertPage(-1, base.addPage([0, 0, 612, 792], 0, res, textOp(72, 700, "Cover sheet")));
    const file = path.join(dir, "rev.pdf");
    fs.writeFileSync(file, Buffer.from(base.saveToBuffer("garbage").asUint8Array()));
    base.destroy();

    const opened = new mupdf.PDFDocument(file);
    const page = opened.loadPage(0);
    const contents = page.getObject().get("Contents");
    const prev = Buffer.from(contents.readStream().asUint8Array());
    contents.writeStream(Buffer.concat([prev, Buffer.from(textOp(72, 640, SECRET), "latin1")]));
    assert.equal(opened.canBeSavedIncrementally(), true);
    const inc = path.join(dir, "inc.pdf");
    opened.save(inc, "incremental");
    opened.destroy();

    const incBytes = fs.readFileSync(inc);
    assert.ok(incBytes.includes(Buffer.from(SECRET)));
    assert.ok((incBytes.toString("latin1").match(/startxref/g) || []).length >= 2);

    const doc = mupdf.Document.openDocument(incBytes, "application/pdf").asPDF();
    assert.ok(doc.countVersions() >= 2);
    markText(doc, SECRET);
    R.applyRedactions(doc, {});
    const bytes = P.saveBytes(doc, null, { rewrite: true });
    const out = P.openBytes(new Uint8Array(bytes));
    assertAbsent(out, bytes, SECRET);
    assert.ok(allText(out).includes("Cover sheet"));
    assert.equal(out.countVersions(), 1);
    assert.equal((bytes.toString("latin1").match(/startxref/g) || []).length, 1);
    const inflated = zlib.inflateSync;
    void inflated;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("redaction API marks, reviews, applies, and saves a new file", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "redline-redact-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const server = createServer({ autoOcrPages: 0, dataDir: path.join(tmp, "data"), pickCommand: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { "X-Redline": "1", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const ct = res.headers.get("content-type") || "";
    return { status: res.status, body: ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  const src = path.join(tmp, "packet.pdf");
  fs.writeFileSync(src, P.saveBytes(buildFixture()));
  assert.equal((await api("POST", "/api/open", { path: src })).status, 200);
  const found = await api("POST", "/api/redact/search", { query: SECRET });
  assert.equal(found.body.total >= 1, true);
  const rejected = found.body.hits.slice(1);
  const accepted = found.body.hits.slice(0, 1);
  assert.ok(accepted.length === 1);
  void rejected;
  const added = await api("POST", "/api/redact/hits", { hits: accepted, color: "black", overlay: "" });
  assert.equal(added.status, 201);
  const marks = await api("GET", "/api/redact/marks");
  assert.equal(marks.body.marks.length, 1);
  const applied = await api("POST", "/api/redact/apply", { sanitize: false, page: 0 });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.permanent, true);
  assert.equal(applied.body.suggest, "packet_redacted.pdf");
  const saved = path.join(tmp, applied.body.suggest);
  const write = await api("POST", "/api/save-as", { path: saved });
  assert.equal(write.status, 200);
  const bytes = fs.readFileSync(saved);
  const out = P.openBytes(new Uint8Array(bytes));
  assertAbsent(out, bytes, SECRET);
  assert.ok(allText(out).includes(KEEP));
  assert.ok(fs.existsSync(src));
  assert.ok(fs.readFileSync(src).includes(Buffer.from(SECRET)));
});

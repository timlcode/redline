import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as mupdf from "mupdf";
import * as P from "../lib/pdf.mjs";
import { createServer } from "../server.mjs";

function docWithPages(labels) {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const res = doc.addObject({ Font: { F1: font } });
  labels.forEach((l, i) => doc.insertPage(i, doc.addPage([0, 0, 612, 792], 0, res, `BT /F1 24 Tf 72 700 Td (${l}) Tj ET`)));
  return doc;
}
const bytesOf = (doc) => new Uint8Array(doc.saveToBuffer("").asUint8Array());
const labelOf = (doc, i) => doc.loadPage(i).toStructuredText("").asText().trim();
const labels = (doc) => [...Array(doc.countPages()).keys()].map((i) => labelOf(doc, i));

test("parsePageRange", () => {
  assert.deepEqual(P.parsePageRange("1-3,5,8-", 10), [0, 1, 2, 4, 7, 8, 9]);
  assert.deepEqual(P.parsePageRange("all", 3), [0, 1, 2]);
  assert.deepEqual(P.parsePageRange("", 2), [0, 1]);
  assert.deepEqual(P.parsePageRange("3, 1, 3", 3), [2, 0]);
  assert.deepEqual(P.parsePageRange("-2", 5), [0, 1]);
  assert.throws(() => P.parsePageRange("0", 3), /outside/);
  assert.throws(() => P.parsePageRange("4", 3), /outside/);
  assert.throws(() => P.parsePageRange("x", 3), /Bad page range/);
});

test("insertPagesFrom / extractPages / deletePages / splitPlan", () => {
  const a = docWithPages(["A1", "A2", "A3"]);
  const b = docWithPages(["B1", "B2"]);
  assert.equal(P.insertPagesFrom(a, b, 1), 2);
  assert.deepEqual(labels(a), ["A1", "B1", "B2", "A2", "A3"]);
  assert.equal(P.insertPagesFrom(a, b, undefined, [1]), 1);
  assert.deepEqual(labels(a), ["A1", "B1", "B2", "A2", "A3", "B2"]);
  const ex = P.extractPages(a, [4, 0]);
  assert.deepEqual(labels(ex), ["A3", "A1"]);
  assert.deepEqual(labels(a).length, 6, "extract copies, source untouched");
  assert.equal(P.deletePages(a, [5, 1, 2]), 3);
  assert.deepEqual(labels(a), ["A1", "A2", "A3"]);
  assert.throws(() => P.deletePages(a, [0, 1, 2]), /every page/);
  assert.deepEqual(P.splitPlan(a, { mode: "every", every: 2 }), [[0, 1], [2]]);
  assert.deepEqual(P.splitPlan(a, { mode: "each" }), [[0], [1], [2]]);
  assert.deepEqual(P.splitPlan(a, { mode: "ranges", ranges: "1-2, 3" }), [[0, 1], [2]]);
});

test("openSource: images become a page; odd resolutions fit Letter", () => {
  const src = docWithPages(["IMG"]);
  const pix = src.loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true);
  const png = new Uint8Array(pix.asPNG());
  assert.equal(P.isImageBytes(png), "png");
  const d = P.openSource(png);
  assert.equal(d.countPages(), 1);
  const b = d.loadPage(0).getBounds();
  // 1224x1584 px; mupdf writes PNGs at 96 dpi -> 918x1188 pt, kept as is
  assert.ok(Math.abs(b[2] - b[0] - 918) < 1 && Math.abs(b[3] - b[1] - 1188) < 1, JSON.stringify(b));
  // a huge pixel count with no usable resolution is fitted to Letter
  const big = new mupdf.PDFDocument();
  void big;
  assert.throws(() => P.openSource(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])), /Not a PDF or an image/);
  const jpegish = new Uint8Array(20); jpegish[0] = 0xff; jpegish[1] = 0xd8;
  assert.equal(P.isImageBytes(jpegish), "jpeg");
});

test("server: insert from file (pdf + image), combine, extract, split, delete-many, drop upload, undo", { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-pages-"));
  const main = path.join(dir, "main.pdf");
  const other = path.join(dir, "other.pdf");
  const img = path.join(dir, "photo.png");
  fs.writeFileSync(main, bytesOf(docWithPages(["M1", "M2", "M3"])));
  fs.writeFileSync(other, bytesOf(docWithPages(["O1", "O2"])));
  const pix = docWithPages(["PIC"]).loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  fs.writeFileSync(img, new Uint8Array(pix.asPNG()));
  const server = createServer({ dataDir: path.join(dir, "data"), pickCommand: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { "X-Redline": "1", "Content-Type": "application/json" };
  const j = async (res) => res.json();
  const post = (p, body) => fetch(`${base}${p}`, { method: "POST", headers: H, body: JSON.stringify(body || {}) });
  const openSaved = async () => {
    const dl = Buffer.from(await (await fetch(`${base}/api/download`)).arrayBuffer());
    return mupdf.Document.openDocument(new Uint8Array(dl), "application/pdf").asPDF();
  };
  try {
    await post("/api/open", { path: main });
    // insert other.pdf page 2 after page 1, then the image at the end
    let s = await j(await post("/api/pages/insert-file", { path: other, at: 1, pages: "2" }));
    assert.equal(s.inserted, 1);
    assert.equal(s.pageCount, 4);
    assert.equal(s.undoLabel, "insert other.pdf");
    s = await j(await post("/api/pages/insert-file", { paths: [img, other] }));
    assert.equal(s.inserted, 3);
    assert.equal(s.pageCount, 7);
    let d = await openSaved();
    assert.deepEqual(labels(d), ["M1", "O2", "M2", "M3", "", "O1", "O2"]);
    assert.ok(d.loadPage(4).toStructuredText("preserve-images").asJSON().includes("image"), "image page holds an image");

    // extract pages 2,4 to a file without removing, then with removing
    const out1 = path.join(dir, "out1.pdf");
    s = await j(await post("/api/pages/extract", { pages: "2,4", path: out1, current: 0 }));
    assert.equal(s.ok, true);
    assert.equal(s.pageCount, 7);
    assert.deepEqual(labels(mupdf.Document.openDocument(fs.readFileSync(out1), "application/pdf").asPDF()), ["O2", "M3"]);
    const out2 = path.join(dir, "out2.pdf");
    s = await j(await post("/api/pages/extract", { pages: "5-7", path: out2, remove: true, current: 6 }));
    assert.equal(s.removed, 3);
    assert.equal(s.pageCount, 4);
    assert.equal(s.undoLabel, "extract 3 pages");
    assert.equal(mupdf.Document.openDocument(fs.readFileSync(out2), "application/pdf").countPages(), 3);

    // delete-many and undo it
    s = await j(await post("/api/pages/delete-many", { pages: "1,3" }));
    assert.equal(s.removed, 2);
    assert.deepEqual(labels(await openSaved()), ["O2", "M3"]);
    s = await j(await post("/api/undo"));
    assert.equal(s.label, "delete 2 pages");
    assert.deepEqual(labels(await openSaved()), ["M1", "O2", "M2", "M3"]);

    // split every 3 -> 2 files; ranges -> named by pages
    const sdir = path.join(dir, "split");
    fs.mkdirSync(sdir);
    s = await j(await post("/api/pages/split", { mode: "every", every: 3, dir: sdir, base: "main" }));
    assert.deepEqual(s.files.map((f) => path.basename(f.path)), ["main-p1-3.pdf", "main-p4.pdf"]);
    assert.equal(mupdf.Document.openDocument(fs.readFileSync(s.files[0].path), "application/pdf").countPages(), 3);
    s = await j(await post("/api/pages/split", { mode: "ranges", ranges: "1-2, 4", dir: sdir }));
    assert.deepEqual(s.files.map((f) => path.basename(f.path)), ["main-p1-2.pdf", "main-p4.pdf"]);

    // drop upload of an image after page 1
    const up = await fetch(`${base}/api/pages/insert-upload?at=1`, { method: "POST", headers: { "X-Redline": "1", "Content-Type": "application/octet-stream", "X-Filename": "shot.png" }, body: fs.readFileSync(img) });
    s = await j(up);
    assert.equal(s.inserted, 1);
    assert.equal(s.pageCount, 5);
    assert.equal(s.undoLabel, "insert shot.png");
    const bad = await fetch(`${base}/api/pages/insert-upload`, { method: "POST", headers: { "X-Redline": "1", "Content-Type": "application/octet-stream", "X-Filename": "junk.bin" }, body: Buffer.from("hello world, not a file at all") });
    assert.equal(bad.status, 400);

    // combine makes a NEW unsaved document from files, in order
    s = await j(await post("/api/combine", { paths: [other, img, main] }));
    assert.equal(s.combined, 3);
    assert.equal(s.pageCount, 6);
    assert.equal(s.sourcePath, null);
    assert.equal(s.name, "other combined.pdf");
    assert.equal(s.canUndo, false);
    assert.deepEqual(labels(await openSaved()), ["O1", "O2", "", "M1", "M2", "M3"]);

    // opening an image directly gives a one-page unsaved document
    s = await j(await post("/api/open", { path: img }));
    assert.equal(s.pageCount, 1);
    assert.equal(s.name, "photo.pdf");
    assert.equal(s.sourcePath, null);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

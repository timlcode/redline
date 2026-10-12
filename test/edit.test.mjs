import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as mupdf from "mupdf";
import * as P from "../lib/pdf.mjs";
import { createServer } from "../server.mjs";

function textDoc() {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const res = doc.addObject({ Font: { F1: font } });
  doc.insertPage(0, doc.addPage([0, 0, 612, 792], 0, res, "BT /F1 14 Tf 72 700 Td 20 TL (Contractor shall verify dimensions) Tj T* (Second line of notes) Tj T* ET"));
  doc.insertPage(1, doc.addPage([0, 0, 612, 792], 0, res, "BT /F1 14 Tf 72 700 Td (Page two) Tj ET"));
  return doc;
}

test("textMap lists characters with quads in reading order", () => {
  const doc = textDoc();
  const m = P.textMap(doc, 0);
  assert.equal(m.lines.length, 2);
  const line1 = m.lines[0].chars.map((c) => c.c).join("");
  assert.equal(line1, "Contractor shall verify dimensions");
  const first = m.lines[0].chars[0];
  assert.equal(first.q.length, 8);
  assert.ok(first.q[0] > 70 && first.q[0] < 74, JSON.stringify(first.q)); // x of 'C' ~ 72pt
  assert.ok(first.q[1] > 75 && first.q[1] < 95, JSON.stringify(first.q)); // top of the line ~ 792-700-ascent
  // characters advance left to right
  const xs = m.lines[0].chars.map((c) => c.q[0]);
  assert.ok(xs.every((x, i) => i === 0 || x > xs[i - 1]));
});

test("text-following highlight, underline and strikeout from quads; move keeps quads", () => {
  const doc = textDoc();
  const m = P.textMap(doc, 0);
  const chars = m.lines[0].chars;
  const f = chars[11].q, l = chars[15].q; // "shall"
  assert.equal(chars.slice(11, 16).map((c) => c.c).join(""), "shall");
  const quad = [f[0], f[1], l[2], l[3], f[4], f[5], l[6], l[7]];
  const zoom = 2;
  const scaled = quad.map((v) => v * zoom);
  const hl = P.createAnnot(doc, { page: 0, tool: "highlight", zoom, quads: [scaled], contents: "shall" });
  assert.equal(hl.kind, "highlight");
  assert.equal(hl.contents, "shall");
  const ul = P.createAnnot(doc, { page: 0, tool: "underline", zoom, quads: [scaled] });
  assert.equal(ul.kind, "underline");
  const so = P.createAnnot(doc, { page: 0, tool: "strikeout", zoom, quads: [scaled] });
  assert.equal(so.kind, "strikeout");
  // bounds hug the word, not the whole line
  const b = hl.rect;
  assert.ok(b[2] - b[0] > 20 && b[2] - b[0] < 50, JSON.stringify(b));
  assert.ok(Math.abs(b[0] - f[0]) < 8, JSON.stringify([b, f])); // bounds carry a small margin
  assert.throws(() => P.createAnnot(doc, { page: 0, tool: "underline", zoom, rect: [10, 10, 50, 20] }), /needs text/);
  const moved = P.patchAnnot(doc, ul.id, { dx: 10, dy: 0, zoom: 1 });
  assert.ok(Math.abs(moved.rect[0] - ul.rect[0] - 10) < 0.5);
  assert.equal(P.listAnnots(doc, 0).length, 3);
});

test("server: undo/redo over markup, page ops and OCR layers", { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-undo-"));
  const file = path.join(dir, "t.pdf");
  fs.writeFileSync(file, new Uint8Array(textDoc().saveToBuffer("").asUint8Array()));
  const server = createServer({ dataDir: path.join(dir, "data"), pickCommand: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { "X-Redline": "1", "Content-Type": "application/json" };
  const j = async (res) => res.json();
  const post = (p, body) => fetch(`${base}${p}`, { method: "POST", headers: H, body: JSON.stringify(body || {}) });
  try {
    let d = await j(await post("/api/open", { path: file }));
    assert.equal(d.canUndo, false);
    const nothing = await post("/api/undo");
    assert.equal(nothing.status, 400);

    const a = await j(await post("/api/annots", { page: 0, tool: "box", zoom: 1, rect: [50, 50, 150, 100] }));
    assert.equal(a.kind, "box");
    d = await j(await fetch(`${base}/api/doc`));
    assert.equal(d.canUndo, true);
    assert.equal(d.undoLabel, "add box");

    await post("/api/pages/delete", { page: 1 });
    d = await j(await fetch(`${base}/api/doc`));
    assert.equal(d.pageCount, 1);
    assert.equal(d.undoLabel, "delete page");

    let u = await j(await post("/api/undo"));
    assert.equal(u.did, "undo");
    assert.equal(u.label, "delete page");
    assert.equal(u.pageCount, 2);
    assert.equal(u.canRedo, true);
    assert.equal((await j(await fetch(`${base}/api/annots?page=0`))).length, 1);

    u = await j(await post("/api/undo"));
    assert.equal(u.label, "add box");
    assert.equal((await j(await fetch(`${base}/api/annots?page=0`))).length, 0);
    assert.equal(u.canUndo, false);

    const r = await j(await post("/api/redo"));
    assert.equal(r.label, "add box");
    const annots = await j(await fetch(`${base}/api/annots?page=0`));
    assert.equal(annots.length, 1);
    assert.equal(annots[0].id, a.id, "ids are stable across undo/redo");

    // a text-following highlight through the API, with quads from the text map
    const m = await j(await fetch(`${base}/api/textmap?page=0`));
    const c = m.lines[1].chars;
    const q = [c[0].q[0], c[0].q[1], c[5].q[2], c[5].q[3], c[0].q[4], c[0].q[5], c[5].q[6], c[5].q[7]].map((v) => v * 1.5);
    const hl = await j(await post("/api/annots", { page: 0, tool: "underline", zoom: 1.5, quads: [q], contents: "Second" }));
    assert.equal(hl.kind, "underline");
    assert.equal((await j(await fetch(`${base}/api/doc`))).undoLabel, "add underline");

    // the saved file reflects the current (post-redo) state
    const dl = Buffer.from(await (await fetch(`${base}/api/download`)).arrayBuffer());
    const re = mupdf.Document.openDocument(new Uint8Array(dl), "application/pdf").asPDF();
    assert.equal(re.countPages(), 2);
    assert.equal(P.listAnnots(re, 0).length, 2);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("server: background OCR on a fresh document is not an undo step; later OCR rides on the previous edit", { timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-undo-ocr-"));
  // one text page is rasterised into an image-only PDF
  const src = textDoc();
  const pix = src.loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true);
  const scan = new mupdf.PDFDocument();
  const img = scan.addImage(new mupdf.Image(pix));
  const res = scan.addObject({ XObject: { Im0: img } });
  scan.insertPage(-1, scan.addPage([0, 0, 612, 792], 0, res, "q 612 0 0 792 0 0 cm /Im0 Do Q"));
  const file = path.join(dir, "scan.pdf");
  fs.writeFileSync(file, new Uint8Array(scan.saveToBuffer("").asUint8Array()));
  const server = createServer({ dataDir: path.join(dir, "data"), pickCommand: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { "X-Redline": "1", "Content-Type": "application/json" };
  const j = async (res) => res.json();
  const post = (p, body) => fetch(`${base}${p}`, { method: "POST", headers: H, body: JSON.stringify(body || {}) });
  try {
    await post("/api/open", { path: file });
    let s;
    for (let i = 0; i < 400; i++) {
      s = await j(await fetch(`${base}/api/ocr`));
      if (!s.running && !s.queued.length) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.deepEqual(s.kinds, ["ocr"]);
    let d = await j(await fetch(`${base}/api/doc`));
    assert.equal(d.canUndo, false, "OCR on open is not undoable");
    // text map now exists on an OCR'd page; select and underline a word
    const m = await j(await fetch(`${base}/api/textmap?page=0`));
    assert.ok(m.lines.length >= 2, JSON.stringify(m.lines.map((l) => l.chars.map((c) => c.c).join(""))));
    const line = m.lines.find((l) => l.chars.map((c) => c.c).join("").includes("Contractor"));
    assert.ok(line);
    const c = line.chars;
    const q = [c[0].q[0], c[0].q[1], c[9].q[2], c[9].q[3], c[0].q[4], c[0].q[5], c[9].q[6], c[9].q[7]];
    const a = await j(await post("/api/annots", { page: 0, tool: "highlight", zoom: 1, quads: [q], contents: "Contractor" }));
    assert.equal(a.kind, "highlight");
    assert.ok(a.rect[2] - a.rect[0] < 120, JSON.stringify(a.rect));
    const u = await j(await post("/api/undo"));
    assert.equal(u.label, "add highlight");
    assert.deepEqual((await j(await fetch(`${base}/api/ocr`))).kinds, ["ocr"], "undoing the markup keeps the OCR layer");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

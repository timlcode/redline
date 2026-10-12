import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as mupdf from "mupdf";
import * as P from "../lib/pdf.mjs";
import * as M from "../lib/measure.mjs";
import { createServer } from "../server.mjs";

test("distance/area/perimeter math", () => {
  assert.equal(M.ptDistance([0, 0], [3, 4]), 5);
  assert.equal(M.ptArea([[0, 0], [4, 0], [0, 3]]), 6);
  assert.equal(M.ptPerimeter([[0, 0], [4, 0], [0, 3]]), 12);
});

test("formatFeetInches", () => {
  assert.equal(M.formatFeetInches(0), `0"`);
  assert.equal(M.formatFeetInches(6), `6"`);
  assert.equal(M.formatFeetInches(12), `1'`);
  assert.equal(M.formatFeetInches(15), `1'-3"`);
  assert.equal(M.formatFeetInches(12.5), `1'-1/2"`);
  assert.equal(M.formatFeetInches(-6), `-6"`);
});

test("common scale presets", () => {
  // ptPerUnit = 864 * (drawing inches / real inches); 72pt = 1in, 12in = 1ft
  assert.ok(Math.abs((864 * 0.25 / 12) - 18) < 1e-6); // 1/4" = 1' -> 18 pt/ft
  assert.ok(Math.abs((864 * 0.125 / 12) - 9) < 1e-6); // 1/8" = 1'
  assert.ok(Math.abs((864 * 1 / 120) - 7.2) < 1e-6); // 1" = 10'
  assert.ok(Math.abs((864 * 12 / 12) - 864) < 1e-6); // full size
  const mm = (72 / 25.4) * 100;
  assert.ok(Math.abs(mm - 283.4646) < 1e-3); // 1:100
  assert.equal(M.formatDistance(18, { ptPerUnit: 18, unit: "ft" }), `1'`); // 1/4"=1' measures 1'
  assert.equal(M.formatDistance(3, { ptPerUnit: 18, unit: "ft" }), `2"`); // 3pt = 2 inches real
});

test("formatDistance/Area by unit", () => {
  assert.equal(M.formatDistance(1, { ptPerUnit: 1, unit: "in" }), `1"`);
  assert.equal(M.formatDistance(18, { ptPerUnit: 1, unit: "in" }), `1'-6"`);
  assert.equal(M.formatDistance(20, { ptPerUnit: 0.05, unit: "ft" }), `400'`); // 1pt = 1/20 ft? no: ptPerUnit=0.05 => 20/0.05 = 400
  assert.equal(M.formatDistance(20, { ptPerUnit: 20, unit: "ft" }), `1'`); // 1ft = 20pt
  assert.equal(M.formatDistance(100, { ptPerUnit: 1, unit: "mm" }), "100 mm");
  assert.equal(M.formatArea(100, { ptPerUnit: 1, unit: "in" }), "100 in²");
});

test("scale persists in the PDF catalog and clears", () => {
  const doc = P.newBlankDocument();
  assert.deepEqual(M.getScale(doc, 0), { ptPerUnit: 1, unit: "in" });
  M.setScale(doc, 0, 48, "ft");
  assert.deepEqual(M.getScale(doc, 0), { ptPerUnit: 48, unit: "ft" });
  assert.deepEqual(M.getScale(doc, 1), { ptPerUnit: 1, unit: "in" });
  const copy = P.openBytes(P.saveBytes(doc));
  assert.deepEqual(M.getScale(copy, 0), { ptPerUnit: 48, unit: "ft" });
  M.clearScale(copy, 0);
  assert.deepEqual(M.getScale(copy, 0), { ptPerUnit: 1, unit: "in" });
});

test("measure annotations carry dimension intent and formatted contents", () => {
  const doc = P.newBlankDocument();
  const line = P.createAnnot(doc, { page: 0, tool: "measure-distance", zoom: 1, from: [10, 10], to: [10, 58], contents: `4'` });
  assert.equal(line.kind, "measure-distance");
  assert.equal(line.type, "Line");
  const a = P.findAnnot(doc, line.id).annot;
  assert.equal(a.getIntent(), "LineDimension");
  assert.equal(line.contents, `4'`);
  const area = P.createAnnot(doc, { page: 0, tool: "measure-area", zoom: 1, points: [[10, 10], [60, 10], [60, 60], [10, 60]], contents: "2500 ft² · 200'" });
  assert.equal(area.kind, "measure-area");
  assert.equal(P.findAnnot(doc, area.id).annot.getIntent(), "PolygonDimension");
  // move moves a dimension line
  const before = line.rect[0];
  const moved = P.patchAnnot(doc, line.id, { dx: 5, dy: 5, zoom: 1 });
  assert.ok(Math.abs(moved.rect[0] - before - 5) < 0.5, JSON.stringify([before, moved.rect[0]]));
  // listAllAnnots includes them; summary labels them
  assert.deepEqual(P.listAllAnnots(doc).map((a) => a.kind).sort(), ["measure-area", "measure-distance"]);
});

test("server: /api/scale set/get/reset is undoable and survives save", { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-scale-"));
  const file = path.join(dir, "t.pdf");
  fs.writeFileSync(file, P.saveBytes(P.newBlankDocument()));
  const server = createServer({ dataDir: path.join(dir, "data"), autoOcrPages: 0, pickCommand: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { "X-Redline": "1", "Content-Type": "application/json" };
  const j = async (r) => r.json();
  try {
    await fetch(`${base}/api/open`, { method: "POST", headers: H, body: JSON.stringify({ path: file }) });
    let s = await j(await fetch(`${base}/api/scale?page=0`));
    assert.deepEqual({ ptPerUnit: s.ptPerUnit, unit: s.unit }, { ptPerUnit: 1, unit: "in" });
    s = await j(await fetch(`${base}/api/scale`, { method: "POST", headers: H, body: JSON.stringify({ page: 0, ptPerUnit: 48, unit: "ft" }) }));
    assert.equal(s.ptPerUnit, 48);
    assert.equal(s.unit, "ft");
    const dl = Buffer.from(await (await fetch(`${base}/api/download`)).arrayBuffer());
    const re = mupdf.Document.openDocument(new Uint8Array(dl), "application/pdf").asPDF();
    assert.deepEqual(M.getScale(re, 0), { ptPerUnit: 48, unit: "ft" });
    // measure-distance via API
    const a = await j(await fetch(`${base}/api/annots`, { method: "POST", headers: H, body: JSON.stringify({ page: 0, tool: "measure-distance", zoom: 1, from: [10, 10], to: [10, 58], contents: "4'" }) }));
    assert.equal(a.kind, "measure-distance");
    // undo the measure-distance annotation, then undo the scale set, then redo
    await fetch(`${base}/api/undo`, { method: "POST", headers: H });
    assert.equal((await j(await fetch(`${base}/api/annots/all`))).length, 0);
    await fetch(`${base}/api/undo`, { method: "POST", headers: H });
    s = await j(await fetch(`${base}/api/scale?page=0`));
    assert.equal(s.ptPerUnit, 1);
    await fetch(`${base}/api/redo`, { method: "POST", headers: H });
    s = await j(await fetch(`${base}/api/scale?page=0`));
    assert.equal(s.ptPerUnit, 48);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

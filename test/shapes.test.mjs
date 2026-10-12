import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as mupdf from "mupdf";
import * as P from "../lib/pdf.mjs";
import { createServer } from "../server.mjs";

const T = process.env.TMPDIR || os.tmpdir();
const doc = () => P.newBlankDocument(2);
const reopen = (d) => P.openBytes(P.saveBytes(d));
test("cloudy rectangle and polygon are standard PDF annotations with visible scallops", () => {
  const d = doc();
  const rect = P.createAnnot(d, { page: 0, tool: "cloud", zoom: 1, rect: [50, 50, 250, 150], color: "red", contents: "Revision 3" });
  const poly = P.createAnnot(d, { page: 0, tool: "cloud", zoom: 1, points: [[300, 50], [500, 80], [460, 180], [310, 160]], color: "blue" });
  assert.equal(rect.kind, "cloud");
  assert.equal(poly.kind, "cloud");
  assert.equal(rect.type, "Square");
  assert.equal(poly.type, "Polygon");
  const a = P.findAnnot(d, rect.id).annot;
  assert.equal(a.getBorderEffect(), "Cloudy");
  assert.equal(a.getBorderEffectIntensity(), 1);
  // a plain rectangle border is only ~2 pixels high. Cloud swells to ~6+ px on this top band.
  const pix = d.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  const data = new Uint8Array(pix.getPixels());
  const W = pix.getWidth();
  let inkRows = 0;
  for (let y = 43; y < 67; y++) {
    let n = 0;
    for (let x = 70; x < 230; x++) if (data[(y * W + x) * 3 + 1] < 200) n++;
    if (n > 15) inkRows++;
  }
  pix.destroy();
  assert.ok(inkRows >= 5, `cloud spans ${inkRows} rows`);
  const copy = reopen(d);
  assert.deepEqual(P.listAnnots(copy, 0).map((a) => a.kind), ["cloud", "cloud"]);
  assert.equal(P.findAnnot(copy, poly.id).annot.getBorderEffect(), "Cloudy");
  P.patchAnnot(copy, rect.id, { dx: 20, dy: 10, zoom: 1 });
  assert.ok(P.findAnnot(copy, rect.id).annot.getBounds()[0] >= rect.rect[0] + 19);
});

test("polygon/polyline vertices, move, save/reopen", () => {
  const d = doc();
  const p = P.createAnnot(d, { page: 0, tool: "polygon", zoom: 1, points: [[50, 50], [150, 50], [100, 130]] });
  const l = P.createAnnot(d, { page: 0, tool: "polyline", zoom: 1, points: [[250, 50], [350, 90], [450, 50]] });
  assert.equal(p.kind, "polygon"); assert.equal(l.kind, "polyline");
  assert.equal(P.findAnnot(d, p.id).annot.getVertices().length, 3);
  assert.equal(P.findAnnot(d, l.id).annot.getVertices().length, 3);
  P.patchAnnot(d, l.id, { dx: 30, dy: 10, zoom: 1 });
  const v = P.findAnnot(d, l.id).annot.getVertices();
  assert.ok(v[0][0] >= 279 && v[0][1] >= 59, JSON.stringify(v));
  assert.deepEqual(P.listAnnots(reopen(d), 0).map((a) => a.kind), ["polygon", "polyline"]);
  assert.throws(() => P.createAnnot(d, { page: 0, tool: "polygon", zoom: 1, points: [[0, 0], [1, 1]] }), /3 points/);
});

test("callout stores a leader, moves with box, survives save/reopen", () => {
  const d = doc();
  const a = P.createAnnot(d, { page: 0, tool: "callout", zoom: 1, point: [100, 200], rect: [250, 250, 500, 320], contents: "Check flashing" });
  assert.equal(a.kind, "callout");
  assert.equal(a.contents, "Check flashing");
  const raw = P.findAnnot(d, a.id).annot.getObject().get("CL").asJS();
  assert.equal(raw.length, 6);
  const moved = P.patchAnnot(d, a.id, { dx: 20, dy: 10, zoom: 1 });
  assert.equal(moved.kind, "callout");
  const raw2 = P.findAnnot(d, a.id).annot.getObject().get("CL").asJS();
  assert.notDeepEqual(raw2, raw);
  const copy = reopen(d);
  assert.equal(P.listAnnots(copy, 0)[0].kind, "callout");
  assert.equal(P.listAnnots(copy, 0)[0].contents, "Check flashing");
});

test("dynamic custom text stamp / image stamp round-trip", () => {
  const d = doc();
  const a = P.createAnnot(d, { page: 0, tool: "custom-stamp", zoom: 1, rect: [50, 50, 350, 120], label: "RECEIVED 10/12/2026 — Tim" });
  assert.equal(a.type, "Stamp"); assert.equal(a.kind, "stamp");
  assert.match(a.stamp, /RECEIVED/);
  const s = P.findAnnot(d, a.id).annot;
  const ap = s.getObject().get("AP").get("N");
  assert.ok(ap && !ap.isNull(), "standard /AP /N appearance");
  // Stamp annotations render in their /AP; they are not page content text.
  assert.match(P.listAnnots(d, 0)[0].contents, /RECEIVED 10\/12\/2026/);
  const pix = d.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  const png = new Uint8Array(pix.asPNG());
  const im = P.createAnnot(d, { page: 0, tool: "image-stamp", zoom: 1, rect: [400, 50, 500, 150], imageBytes: png, label: "Job logo" });
  assert.equal(im.kind, "stamp");
  assert.equal(P.listAnnots(reopen(d), 0).length, 2);
  assert.equal(P.listAnnots(reopen(d), 0)[1].stamp, "Job logo");
});

test("server: every new tool is undoable, stamps settings and image upload", { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(T, "redline-shapes-"));
  const file = path.join(dir, "t.pdf");
  fs.writeFileSync(file, P.saveBytes(doc()));
  const server = createServer({ dataDir: path.join(dir, "data"), autoOcrPages: 0, pickCommand: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { "X-Redline": "1", "Content-Type": "application/json" };
  const post = (p, body) => fetch(`${base}${p}`, { method: "POST", headers: H, body: JSON.stringify(body || {}) });
  const j = async (r) => r.json();
  try {
    await post("/api/open", { path: file });
    const st = await j(await post("/api/stamps", { label: "RECEIVED {date} — {author}", dynamic: true }));
    assert.equal(st.dynamic, true);
    assert.equal((await j(await fetch(`${base}/api/stamps`))).stamps.length, 1);
    const resolved = await j(await post("/api/stamps/resolve", { label: st.label }));
    assert.match(resolved.label, /RECEIVED 20\d\d-\d\d-\d\d/);
    assert.doesNotMatch(resolved.label, /\{author\}/);
    const cloud = await j(await post("/api/annots", { page: 0, tool: "cloud", zoom: 1, rect: [50, 50, 250, 150] }));
    assert.equal(cloud.kind, "cloud");
    const co = await j(await post("/api/annots", { page: 0, tool: "callout", zoom: 1, point: [20, 100], rect: [300, 50, 500, 100], contents: "Fix this" }));
    assert.equal(co.kind, "callout");
    const cs = await j(await post("/api/annots", { page: 0, tool: "custom-stamp", zoom: 1, rect: [50, 200, 350, 270], label: resolved.label }));
    assert.equal(cs.kind, "stamp");
    const pix = P.newBlankDocument().loadPage(0).toPixmap(mupdf.Matrix.scale(0.2, 0.2), mupdf.ColorSpace.DeviceRGB, false, true);
    const up = await fetch(`${base}/api/annots/image-stamp?page=1&zoom=1&rect=40,40,180,100&label=Logo`, { method: "POST", headers: { "X-Redline": "1" }, body: Buffer.from(new Uint8Array(pix.asPNG())) });
    assert.equal(up.status, 201);
    assert.equal((await j(up)).kind, "stamp");
    const all = await j(await fetch(`${base}/api/annots/all`));
    assert.deepEqual(all.map((a) => a.kind), ["cloud", "callout", "stamp", "stamp"]);
    const csv = await (await fetch(`${base}/api/annots/summary.csv`)).text();
    assert.match(csv, /Revision cloud/);
    assert.match(csv, /Callout/);
    await post("/api/undo");
    assert.equal((await j(await fetch(`${base}/api/annots/all`))).length, 3);
    await fetch(`${base}/api/stamps/${st.id}`, { method: "DELETE", headers: H });
    assert.equal((await j(await fetch(`${base}/api/stamps`))).stamps.length, 0);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as mupdf from "mupdf";
import { minAreaRect, orderClockwise, sortBoxes, dbPostProcess, DET_DEFAULTS } from "../lib/ocr/detect.mjs";
import { ctcDecode, loadDict, recResize, packPadded } from "../lib/ocr/recognize.mjs";
import { resize, rotateCropInfo, rot90, perspectiveTransform, makeImage } from "../lib/ocr/image.mjs";
import { wordBoxes } from "../lib/ocr/index.mjs";
import { encodeLatin, pageTextKind, writeTextLayer, removeTextLayer } from "../lib/textlayer.mjs";
import * as O from "../lib/ocrdoc.mjs";
import { createServer } from "../server.mjs";

// ---------- geometry ----------

test("minAreaRect of an axis-aligned rectangle", () => {
  const pts = [];
  for (let x = 10; x <= 110; x += 5) for (let y = 20; y <= 40; y += 5) pts.push([x, y]);
  const r = minAreaRect(pts);
  const [a, b] = [r.w, r.h].sort((p, q) => p - q);
  assert.ok(Math.abs(a - 20) < 1e-6 && Math.abs(b - 100) < 1e-6, `got ${r.w}x${r.h}`);
  assert.ok(Math.abs(r.cx - 60) < 1e-6 && Math.abs(r.cy - 30) < 1e-6);
});

test("minAreaRect of a rotated rectangle keeps its size", () => {
  const ang = 0.4, c = Math.cos(ang), s = Math.sin(ang);
  const pts = [];
  for (let u = 0; u <= 200; u += 4) for (let v = 0; v <= 30; v += 3) pts.push([u * c - v * s + 50, u * s + v * c + 50]);
  const r = minAreaRect(pts);
  const [a, b] = [r.w, r.h].sort((p, q) => p - q);
  assert.ok(Math.abs(a - 30) < 0.5 && Math.abs(b - 200) < 0.5, `got ${r.w}x${r.h}`);
});

test("orderClockwise yields tl,tr,br,bl", () => {
  const o = orderClockwise([[100, 10], [0, 0], [0, 50], [100, 60]]);
  assert.deepEqual(o, [[0, 0], [100, 10], [100, 60], [0, 50]]);
});

test("sortBoxes reads top-to-bottom then left-to-right", () => {
  const b = (x, y) => [[x, y], [x + 50, y], [x + 50, y + 10], [x, y + 10]];
  const boxes = [b(300, 100), b(10, 100), b(10, 3), b(200, 102)];
  const r = sortBoxes(boxes, [1, 2, 3, 4]);
  assert.deepEqual(r.scores, [3, 2, 4, 1]);
});

test("dbPostProcess finds a text blob and scales to the source image", () => {
  const W = 64, H = 32;
  const prob = new Float32Array(W * H);
  for (let y = 10; y < 20; y++) for (let x = 8; x < 40; x++) prob[y * W + x] = 0.95;
  const { boxes, scores } = dbPostProcess(prob, W, H, 640, 320, DET_DEFAULTS);
  assert.equal(boxes.length, 1);
  assert.ok(scores[0] > 0.7, String(scores[0]));
  const xs = boxes[0].map((p) => p[0]), ys = boxes[0].map((p) => p[1]);
  // unclipped by ~ area*1.6/perimeter on each side, scaled x10
  assert.ok(Math.min(...xs) < 80 && Math.max(...xs) > 390, JSON.stringify(boxes[0]));
  assert.ok(Math.min(...ys) < 100 && Math.max(...ys) > 190, JSON.stringify(boxes[0]));
});

test("perspectiveTransform maps the source corners onto the target", () => {
  const src = [[3, 4], [103, 7], [101, 36], [2, 33]];
  const dst = [[0, 0], [100, 0], [100, 30], [0, 30]];
  const m = perspectiveTransform(src, dst);
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const w = m[6] * x + m[7] * y + m[8];
    const u = (m[0] * x + m[1] * y + m[2]) / w, v = (m[3] * x + m[4] * y + m[5]) / w;
    assert.ok(Math.abs(u - dst[i][0]) < 1e-6 && Math.abs(v - dst[i][1]) < 1e-6);
  }
});

test("rotateCropInfo turns tall crops and rot90 is counter-clockwise", () => {
  const img = makeImage(4, 2);
  img.data.fill(0);
  img.data[(0 * 4 + 3) * 3] = 255; // red at top-right
  const r = rot90(img);
  assert.equal(r.width, 2); assert.equal(r.height, 4);
  assert.equal(r.data[0], 255); // ends up top-left
  const tall = makeImage(10, 40);
  const c = rotateCropInfo(tall, [[0, 0], [10, 0], [10, 40], [0, 40]]);
  assert.equal(c.rotated, true);
  assert.equal(c.img.width, 40);
});

test("resize keeps a flat colour flat", () => {
  const img = makeImage(9, 7);
  img.data.fill(77);
  const r = resize(img, 20, 3);
  assert.ok(r.data.every((v) => v === 77));
});

// ---------- recognition ----------

test("ctcDecode collapses repeats and blanks", () => {
  const dict = loadDict("a\nb\nc");
  assert.deepEqual(dict, ["blank", "a", "b", "c", " "]);
  const C = dict.length;
  const steps = [0, 1, 1, 0, 2, 2, 2, 4, 3, 0, 3];
  const logits = new Float32Array(steps.length * C);
  steps.forEach((s, t) => (logits[t * C + s] = 0.9));
  const r = ctcDecode(logits, steps.length, C, dict);
  assert.equal(r.text, "ab cc");
  assert.deepEqual(r.cols, [1, 4, 7, 8, 10]);
});

test("packPadded leaves the padding at 0 in normalised space", () => {
  const img = makeImage(4, 2);
  img.data.fill(255);
  const out = new Float32Array(3 * 2 * 10);
  packPadded(img, 10, out);
  assert.equal(out[0], 1); // white -> +1
  assert.equal(out[5], 0); // padding
  const rs = recResize(makeImage(100, 10), 48, 320 / 48);
  assert.equal(rs.height, 48); assert.equal(rs.width, 320);
});

test("wordBoxes splits on spaces along the reading edge", () => {
  const box = [[0, 0], [100, 0], [100, 10], [0, 10]];
  const words = wordBoxes(box, { text: "ab cd", cols: [0, 2, 4, 6, 8], T: 10, whRatio: 10, maxWhRatio: 10 });
  assert.equal(words.length, 2);
  assert.equal(words[0].text, "ab");
  assert.ok(words[0].box[1][0] < words[1].box[0][0]);
  assert.ok(words[1].box[1][0] > 90);
});

// ---------- text layer ----------

test("encodeLatin escapes and folds typographic punctuation", () => {
  assert.equal(encodeLatin("a(b)\\c"), "a\\(b\\)\\\\c");
  assert.equal(encodeLatin("it\u2019s \u2014 \u4e2d"), "it's - ?");
});

function syntheticScan(rotate = 0) {
  const src = new mupdf.PDFDocument();
  const font = src.addSimpleFont(new mupdf.Font("Helvetica"));
  const res = src.addObject({ Font: { F1: font } });
  src.insertPage(0, src.addPage([0, 0, 612, 792], 0, res, "BT /F1 20 Tf 72 700 Td 28 TL (Canopy replacement schedule) Tj T* (Steel delivery 10/19/2026) Tj T* ET"));
  const pix = src.loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true);
  const scan = new mupdf.PDFDocument();
  const img = scan.addImage(new mupdf.Image(pix));
  const r2 = scan.addObject({ XObject: { Im0: img } });
  scan.insertPage(-1, scan.addPage([0, 0, 612, 792], rotate, r2, "q 612 0 0 792 0 0 cm /Im0 Do Q"));
  const bytes = new Uint8Array(scan.saveToBuffer("").asUint8Array()); // copy: WASM views detach when the heap grows
  return mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
}

test("writeTextLayer makes an image-only page searchable without touching pixels", () => {
  const doc = syntheticScan();
  assert.equal(pageTextKind(doc, 0), "none");
  const snap = (d) => { const p = d.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true); const h = Buffer.from(new Uint8Array(p.getPixels())).toString("base64").length + ":" + Buffer.from(new Uint8Array(p.getPixels())).reduce((a, b) => (a * 31 + b) % 1000000007, 7); p.destroy(); return h; };
  const before = snap(doc);
  const zoom = 2;
  const lines = [{ text: "Canopy replacement schedule", box: [[144, 150], [500, 150], [500, 190], [144, 190]], words: [
    { text: "Canopy", box: [[144, 150], [230, 150], [230, 190], [144, 190]] },
    { text: "replacement", box: [[236, 150], [380, 150], [380, 190], [236, 190]] },
    { text: "schedule", box: [[386, 150], [500, 150], [500, 190], [386, 190]] },
  ] }];
  assert.equal(writeTextLayer(doc, 0, lines, zoom), 3);
  assert.equal(pageTextKind(doc, 0), "ocr");
  const text = O.pageText(doc, 0);
  assert.match(text, /Canopy replacement schedule/);
  const hits = O.searchPage(doc, 0, "REPLACEMENT");
  assert.equal(hits.length, 1);
  const q = hits[0][0];
  assert.ok(q[0] > 110 && q[0] < 125 && q[1] > 70 && q[1] < 80, JSON.stringify(q));
  assert.equal(snap(doc), before);
  // survives a save/reopen and can be replaced or removed
  const re = mupdf.Document.openDocument(new Uint8Array(doc.saveToBuffer("garbage").asUint8Array()), "application/pdf").asPDF();
  assert.equal(pageTextKind(re, 0), "ocr");
  assert.equal(writeTextLayer(re, 0, [{ text: "other", box: [[10, 10], [100, 10], [100, 30], [10, 30]], words: [] }], 2), 1);
  assert.match(O.pageText(re, 0), /other/);
  assert.doesNotMatch(O.pageText(re, 0), /Canopy/);
  assert.equal(removeTextLayer(re, 0), true);
  assert.equal(O.pageText(re, 0).trim(), "");
});

// ---------- engine, end to end (needs the bundled models) ----------

test("engine reads a synthetic scan, upright and rotated", { timeout: 120000 }, async () => {
  for (const rot of [0, 90]) {
    const doc = syntheticScan(rot);
    const r = await O.ocrPage(doc, 0);
    assert.equal(r.skipped, false);
    assert.ok(r.lines >= 2, `rot ${rot}: ${r.lines} lines`);
    const text = O.pageText(doc, 0);
    assert.match(text, /Canopy replacement schedule/, `rot ${rot}: ${text}`);
    assert.match(text, /Steel delivery 10\/19\/2026/, `rot ${rot}: ${text}`);
    assert.equal(O.searchPage(doc, 0, "delivery").length, 1);
    // a second run skips pages that already have native text only; OCR'd pages are redone
    const again = await O.ocrPage(doc, 0);
    assert.equal(again.skipped, false);
  }
});

function syntheticScanPages(n) {
  const one = syntheticScan();
  const out = new mupdf.PDFDocument();
  for (let i = 0; i < n; i++) out.graftPage(-1, one, 0);
  return new Uint8Array(out.saveToBuffer("").asUint8Array());
}

async function idle(base, j) {
  let s;
  for (let i = 0; i < 400; i++) {
    s = await j(await fetch(`${base}/api/ocr`));
    if (!s.running && s.queued.length === 0) return s;
    await new Promise((r) => setTimeout(r, 250));
  }
  return s;
}

test("server: small scans are read on open; big ones lazily, with Read all and Stop", { timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-ocr-"));
  const small = path.join(dir, "small.pdf");
  const big = path.join(dir, "big.pdf");
  fs.writeFileSync(small, syntheticScanPages(2));
  fs.writeFileSync(big, syntheticScanPages(12));
  const server = createServer({ dataDir: path.join(dir, "data"), pickCommand: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { "X-Redline": "1", "Content-Type": "application/json" };
  const j = async (res) => res.json();
  try {
    // small: queued automatically on open, finished without any request, not marked dirty
    await fetch(`${base}/api/open`, { method: "POST", headers: H, body: JSON.stringify({ path: small }) });
    let s = await idle(base, j);
    assert.equal(s.error, null);
    assert.deepEqual(s.kinds, ["ocr", "ocr"]);
    assert.equal(s.unread, 0);
    assert.equal((await j(await fetch(`${base}/api/doc`))).dirty, false);
    const sr = await j(await fetch(`${base}/api/search?q=canopy`));
    assert.equal(sr.total, 2);
    // the text is in what gets saved/sent
    const dl = Buffer.from(await (await fetch(`${base}/api/download`)).arrayBuffer());
    const re = mupdf.Document.openDocument(new Uint8Array(dl), "application/pdf").asPDF();
    assert.equal(pageTextKind(re, 1), "ocr");

    // big: nothing on open
    await fetch(`${base}/api/open`, { method: "POST", headers: H, body: JSON.stringify({ path: big }) });
    s = await j(await fetch(`${base}/api/ocr`));
    assert.equal(s.running, false);
    assert.equal(s.unread, 12);
    // viewer asks for the page on screen + look-ahead, front of the queue
    const q = await j(await fetch(`${base}/api/ocr`, { method: "POST", headers: H, body: JSON.stringify({ pages: [5, 6, 7, 4], front: true }) }));
    assert.equal(q.running, true);
    s = await idle(base, j);
    assert.deepEqual([4, 5, 6, 7].map((i) => s.kinds[i]), ["ocr", "ocr", "ocr", "ocr"]);
    assert.equal(s.unread, 8);
    assert.equal(s.kinds[0], "none");
    // Read all, then Stop
    const all = await j(await fetch(`${base}/api/ocr`, { method: "POST", headers: H, body: JSON.stringify({ pages: "all" }) }));
    assert.equal(all.queued.length + (all.page >= 0 ? 1 : 0), 8);
    const c = await j(await fetch(`${base}/api/ocr/cancel`, { method: "POST", headers: H }));
    assert.equal(c.queued.length, 0);
    s = await idle(base, j);
    assert.ok(s.unread >= 6, `unread ${s.unread}`);
    // page order change drops the cache; status still consistent
    await fetch(`${base}/api/pages/delete`, { method: "POST", headers: H, body: JSON.stringify({ page: 0 }) });
    s = await j(await fetch(`${base}/api/ocr`));
    assert.equal(s.kinds.length, 11);
    const txt = await (await fetch(`${base}/api/text?page=4`)).text();
    assert.match(txt, /Steel delivery/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

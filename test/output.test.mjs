import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import * as mupdf from "mupdf";
import * as P from "../lib/pdf.mjs";
import * as F from "../lib/forms.mjs";
import { flattenDocument } from "../lib/flatten.mjs";
import { compressDocument } from "../lib/compress.mjs";
import { buildConstructionForms } from "./fixtures/forms.mjs";
import { createServer } from "../server.mjs";

function ink(page, extras, rect) {
  const pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, extras);
  const png = PNG.sync.read(Buffer.from(pix.asPNG()));
  pix.destroy();
  const [x0, y0, x1, y1] = (rect || [0, 0, png.width, png.height]).map((v) => Math.round(v));
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(png.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(png.width, x1); x++) {
      const i = (y * png.width + x) * 4;
      if (png.data[i] < 80 || png.data[i + 1] < 40 && png.data[i] > 150) n++;
    }
  }
  return n;
}

function imageDoc(pixelW, displayW) {
  const doc = new mupdf.PDFDocument();
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, pixelW, pixelW], false);
  pix.clear(240);
  const px = pix.getPixels();
  for (let y = 0; y < pixelW; y++) {
    for (let x = 0; x < pixelW; x++) {
      const i = (y * pixelW + x) * 3;
      px[i] = (x * 3) % 255;
      px[i + 1] = (y * 5) % 255;
      px[i + 2] = 40;
    }
  }
  const image = new mupdf.Image(pix);
  const ref = doc.addImage(image);
  const h = displayW;
  const contents = `q ${displayW} 0 0 ${h} 36 36 cm /Im0 Do Q\nBT /F1 12 Tf 1 0 0 1 36 20 Tm (North wing) Tj ET`;
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const res = doc.addObject({ Font: { F1: font }, XObject: { Im0: ref } });
  doc.insertPage(0, doc.addPage([0, 0, 612, 792], 0, res, contents));
  pix.destroy();
  return doc;
}

test("flatten writes filled fields and markup into the page", () => {
  const doc = P.openBytes(new Uint8Array(buildConstructionForms()));
  const fields = F.listFields(doc);
  const project = fields.find((f) => f.name === "project");
  F.setFieldValue(doc, project.id, "North wing");
  P.createAnnot(doc, { page: 0, tool: "box", zoom: 1, rect: [40, 40, 120, 80], color: "red" });
  assert.equal(doc.loadPage(0).getAnnotations().filter((a) => a.getType() !== "Widget").length, 1);
  flattenDocument(doc, { forms: true, annotations: true });
  const bytes = P.saveBytes(doc);
  const re = P.openBytes(new Uint8Array(bytes));
  assert.equal(re.loadPage(0).getWidgets().length, 0);
  assert.equal(re.loadPage(0).getAnnotations().length, 0);
  const text = re.loadPage(0).toStructuredText({}).asText();
  assert.match(text, /North wing/);
  assert.ok(ink(re.loadPage(0), false, [40, 40, 120, 80]) > 50, "markup remains in the page content");
});

test("compress downsamples an oversized picture and reports both sizes", () => {
  const doc = imageDoc(800, 200);
  const beforeImage = doc.loadImage(doc.loadPage(0).getObject().get("Resources", "XObject", "Im0"));
  assert.equal(beforeImage.getWidth(), 800);
  const result = compressDocument(doc, { dpi: 72, quality: 60 });
  assert.ok(result.before > result.after, `${result.before} -> ${result.after}`);
  assert.equal(result.imagesChanged, 1);
  assert.ok(result.after < result.before * 0.5);
  const re = P.openBytes(new Uint8Array(P.saveBytes(doc)));
  const image = re.loadImage(re.loadPage(0).getObject().get("Resources", "XObject", "Im0"));
  assert.ok(image.getWidth() < 800);
  assert.ok(image.getWidth() <= 220, `width ${image.getWidth()}`);
  assert.match(re.loadPage(0).toStructuredText({}).asText(), /North wing/);
});

test("compress leaves a text-only file unchanged and can make pictures gray", () => {
  const plain = P.newBlankDocument();
  P.createAnnot(plain, { page: 0, tool: "text", zoom: 1, rect: [40, 40, 200, 80], contents: "Note" });
  const same = compressDocument(plain, { dpi: 72, quality: 50 });
  assert.equal(same.imagesChanged, 0);
  assert.equal(same.after, same.before);

  const doc = imageDoc(400, 200);
  const gray = compressDocument(doc, { dpi: 36, quality: 50, grayscale: true });
  assert.equal(gray.imagesChanged, 1);
  assert.equal(gray.grayscale, true);
  const re = P.openBytes(new Uint8Array(P.saveBytes(doc)));
  const image = re.loadImage(re.loadPage(0).getObject().get("Resources", "XObject", "Im0"));
  assert.equal(image.getNumberOfComponents(), 1);
});

test("print page range returns only those pages, with fields and markup flattened", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-print-"));
  const file = path.join(dir, "pay.pdf");
  fs.writeFileSync(file, buildConstructionForms());
  const server = createServer({ dataDir: path.join(dir, "data"), pickCommand: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { "X-Redline": "1", "Content-Type": "application/json" };
  try {
    await fetch(`${base}/api/open`, { method: "POST", headers: H, body: JSON.stringify({ path: file }) });
    await fetch(`${base}/api/annots`, { method: "POST", headers: H, body: JSON.stringify({ page: 1, tool: "box", zoom: 1, rect: [40, 40, 100, 90], color: "red" }) });
    const bad = await fetch(`${base}/api/print`, { method: "POST", headers: H, body: JSON.stringify({ pages: "9" }) });
    assert.equal(bad.status, 400);
    const res = await fetch(`${base}/api/print`, { method: "POST", headers: H, body: JSON.stringify({ pages: "2-3" }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    const printed = P.openBytes(new Uint8Array(await res.arrayBuffer()));
    assert.equal(printed.countPages(), 2);
    assert.equal(printed.loadPage(0).getWidgets().length, 0);
    assert.equal(printed.loadPage(0).getAnnotations().length, 0);
    assert.ok(ink(printed.loadPage(0), false, [40, 40, 100, 90]) > 20);
    const text = printed.loadPage(1).toStructuredText({}).asText();
    assert.match(text, /LIEN WAIVER/);
    const still = P.openBytes(new Uint8Array(fs.readFileSync(file)));
    assert.ok(still.loadPage(0).getWidgets().length > 0, "printing leaves the open file editable");
  } finally {
    server.close();
  }
});

test("compress reports the size before and after", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-compress-"));
  const file = path.join(dir, "photo.pdf");
  fs.writeFileSync(file, P.saveBytes(imageDoc(600, 180)));
  const server = createServer({ dataDir: path.join(dir, "data"), pickCommand: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { "X-Redline": "1", "Content-Type": "application/json" };
  try {
    await fetch(`${base}/api/open`, { method: "POST", headers: H, body: JSON.stringify({ path: file }) });
    const preview = await (await fetch(`${base}/api/compress`, { method: "POST", headers: H, body: JSON.stringify({ dpi: 72, quality: 50, preview: true }) })).json();
    assert.ok(preview.before > preview.after);
    assert.equal(preview.imagesChanged, 1);
    const applied = await (await fetch(`${base}/api/compress`, { method: "POST", headers: H, body: JSON.stringify({ dpi: 72, quality: 50, preview: false }) })).json();
    assert.ok(applied.before > applied.after);
    const saved = await (await fetch(`${base}/api/save`, { method: "POST", headers: H, body: JSON.stringify({}) })).json();
    assert.equal(saved.ok, true);
  } finally {
    server.close();
  }
  const re = P.openBytes(new Uint8Array(fs.readFileSync(file)));
  const image = re.loadImage(re.loadPage(0).getObject().get("Resources", "XObject", "Im0"));
  assert.ok(image.getWidth() < 600);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import * as mupdf from "mupdf";
import * as P from "../lib/pdf.mjs";
import { pageTextKind } from "../lib/textlayer.mjs";
import { createServer } from "../server.mjs";

function decode(buf) {
  return PNG.sync.read(buf);
}

function px(png, x, y) {
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

function pageWithText() {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const res = doc.addObject({ Font: { F1: font } });
  doc.insertPage(0, doc.addPage([0, 0, 612, 792], 0, res, "BT /F1 24 Tf 48 740 Td (TOPLEFT MARK) Tj ET"));
  return doc;
}

function assertTileMatches(doc, zoom, tile) {
  const full = decode(P.renderPage(doc, 0, zoom));
  const part = decode(P.renderTile(doc, 0, zoom, tile.x, tile.y, tile.w, tile.h, 1));
  assert.equal(part.width, tile.w);
  assert.equal(part.height, tile.h);
  for (let y = 0; y < tile.h; y += 7) {
    for (let x = 0; x < tile.w; x += 7) {
      assert.deepEqual(px(part, x, y), px(full, tile.x + x, tile.y + y));
    }
  }
}

test("a tile matches the same pixels of a full-page render, including after rotation", () => {
  const doc = pageWithText();
  P.createAnnot(doc, { page: 0, tool: "box", zoom: 1, rect: [40, 40, 160, 100], color: "red" });
  assertTileMatches(doc, 1, { x: 0, y: 0, w: 80, h: 50 });
  assertTileMatches(doc, 1, { x: 40, y: 30, w: 90, h: 70 });
  assertTileMatches(doc, 2, { x: 0, y: 0, w: 120, h: 80 });
  const again = P.renderTile(doc, 0, 1, 0, 0, 80, 50, 1);
  assert.equal(Buffer.compare(again, P.renderTile(doc, 0, 1, 0, 0, 80, 50, 1)), 0);

  P.rotatePage(doc, 0, 90);
  // Rotation changes page contents; the viewer bumps the revision token so the
  // display list built for the previous orientation is not reused.
  const rotated = decode(P.renderTile(doc, 0, 1, 0, 0, 60, 40, 2));
  const full = decode(P.renderPage(doc, 0, 1));
  assert.equal(rotated.width, 60);
  assert.equal(rotated.height, 40);
  for (let y = 0; y < 40; y += 7) {
    for (let x = 0; x < 60; x += 7) {
      assert.deepEqual(px(rotated, x, y), px(full, x, y));
    }
  }
});

test("tilesCovering is the fixed grid that intersects the viewport", () => {
  const tiles = P.tilesCovering(1102, 1426, { x: 0, y: 0, w: 1100, h: 800 });
  assert.deepEqual(tiles[0], { x: 0, y: 0, w: 512, h: 512 });
  assert.ok(tiles.every((t) => t.x % 512 === 0 && t.y % 512 === 0));
  assert.ok(tiles.some((t) => t.y === 512));
  assert.equal(P.tilesCovering(100, 100, { x: 200, y: 200, w: 10, h: 10 }).length, 0);
});

test("page text kind uses the content stream and still treats a blank page as unscanned", () => {
  const doc = pageWithText();
  doc.insertPage(1, doc.addPage([0, 0, 612, 792], 0, {}, " "));
  assert.equal(pageTextKind(doc, 0), "text");
  assert.equal(pageTextKind(doc, 1), "none");
});

test("HTTP tile endpoint matches the full page", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "redline-tile-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const server = createServer({ autoOcrPages: 0, dataDir: path.join(tmp, "data"), pickCommand: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const src = path.join(tmp, "page.pdf");
  fs.writeFileSync(src, P.saveBytes(pageWithText()));
  const opened = await fetch(`${base}/api/open`, {
    method: "POST",
    headers: { "X-Redline": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ path: src }),
  });
  assert.equal(opened.status, 200);
  const full = decode(Buffer.from(await (await fetch(`${base}/api/page/0?zoom=1`)).arrayBuffer()));
  const tile = decode(Buffer.from(await (await fetch(`${base}/api/page/0/tile?zoom=1&x=10&y=20&w=40&h=30`)).arrayBuffer()));
  assert.equal(tile.width, 40);
  assert.deepEqual(px(tile, 5, 5), px(full, 15, 25));
  const bad = await fetch(`${base}/api/page/0/tile?zoom=1&x=-1&y=0&w=10&h=10`);
  assert.equal(bad.status, 400);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import * as mupdf from "mupdf";
import * as P from "../lib/pdf.mjs";
import * as F from "../lib/forms.mjs";
import * as S from "../lib/signatures.mjs";
import { hasDigitalSigner, setDigitalSigner, signWithCertificate } from "../lib/digitalsign.mjs";
import { buildConstructionForms } from "./fixtures/forms.mjs";
import { createServer } from "../server.mjs";

function strokePng() {
  const png = new PNG({ width: 120, height: 40 });
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 120; x++) {
      const i = (y * 120 + x) * 4;
      const on = y > 16 && y < 22 && x > 8 && x < 110;
      png.data[i] = on ? 10 : 0;
      png.data[i + 1] = on ? 10 : 0;
      png.data[i + 2] = on ? 10 : 0;
      png.data[i + 3] = on ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

function darkIn(page, rect, extras = true) {
  const pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, extras);
  const png = PNG.sync.read(Buffer.from(pix.asPNG()));
  pix.destroy();
  const [x0, y0, x1, y1] = rect.map((v) => Math.round(v));
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(png.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(png.width, x1); x++) {
      const i = (y * png.width + x) * 4;
      if (png.data[i] < 80) n++;
    }
  }
  return n;
}

test("typed, drawn, and saved signatures stay in app data", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-signs-"));
  const typed = S.renderTypedSignature("North", { kind: "signature" });
  assert.ok(typed.length > 100);
  const saved = S.saveSignature(dir, typed, { kind: "signature", mode: "type" });
  const initials = S.saveSignature(dir, strokePng(), { kind: "initials", mode: "draw" });
  const items = S.listSignatures(dir);
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, "initials");
  assert.ok(fs.existsSync(path.join(dir, "signatures", `${saved.id}.png`)));
  assert.ok(!fs.existsSync(path.join(process.cwd(), "signatures")));
  const raw = S.readSignature(dir, initials.id);
  assert.ok(raw.length > 20);
  S.deleteSignature(dir, initials.id);
  assert.equal(S.listSignatures(dir).length, 1);
  assert.throws(() => S.readSignature(dir, "../index"), /Unknown signature/);
});

test("a placed signature can be moved and resized, then stamped into the page", () => {
  const doc = P.newBlankDocument();
  const png = strokePng();
  const placed = S.placeSignature(doc, { page: 0, zoom: 1, rect: [80, 100, 220, 150], png, kind: "signature" });
  assert.equal(placed.kind, "signature");
  assert.ok(darkIn(doc.loadPage(0), placed.rect) > 10);
  const moved = P.patchAnnot(doc, placed.id, { dx: 40, dy: 30, zoom: 1 });
  assert.ok(Math.abs(moved.rect[0] - placed.rect[0] - 40) < 1);
  const resized = P.patchAnnot(doc, placed.id, { rect: [moved.rect[0], moved.rect[1], moved.rect[0] + 200, moved.rect[1] + 80], zoom: 1 });
  assert.ok(resized.rect[2] - resized.rect[0] > 180);
  assert.ok(darkIn(doc.loadPage(0), resized.rect) > 10);
  const baked = S.documentWithStampedSignatures(doc);
  assert.equal(baked.count, 1);
  assert.equal(S.countPlacedSignatures(baked.doc), 0);
  assert.equal(baked.doc.loadPage(0).getAnnotations().length, 0);
  assert.ok(darkIn(baked.doc.loadPage(0), resized.rect, false) > 10, "stamped ink is part of the page");
});

test("a signature appearance fills a signature field without a certificate", () => {
  const doc = P.openBytes(new Uint8Array(buildConstructionForms()));
  const field = F.listFields(doc).find((f) => f.name === "contractorSign");
  assert.equal(hasDigitalSigner(), false);
  assert.throws(() => signWithCertificate(field), (e) => e.code === "digital-signature-unavailable" && e.status === 501);
  let seen = null;
  setDigitalSigner((request) => { seen = request.name; return { accepted: true }; });
  try {
    const signed = signWithCertificate(F.findField(doc, field.id));
    assert.equal(signed.accepted, true);
    assert.equal(seen, "contractorSign");
  } finally {
    setDigitalSigner(null);
  }
  F.applySignatureAppearance(doc, field.id, strokePng());
  const re = P.openBytes(new Uint8Array(P.saveBytes(doc)));
  const again = F.listFields(re).find((f) => f.name === "contractorSign");
  assert.equal(again.type, "signature");
  assert.ok(darkIn(re.loadPage(0), again.rect) > 10, "signature picture shows in the field");
  assert.equal(re.loadPage(0).getWidgets().length > 0, true);
});

test("saving stamps a placed signature and leaves the library on disk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-sign-save-"));
  const file = path.join(dir, "sheet.pdf");
  fs.writeFileSync(file, P.saveBytes(P.newBlankDocument()));
  const dataDir = path.join(dir, "data");
  const server = createServer({ dataDir, pickCommand: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { "X-Redline": "1" };
  try {
    await fetch(`${base}/api/open`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ path: file }) });
    const png = strokePng();
    const stored = await fetch(`${base}/api/signatures`, {
      method: "POST",
      headers: { ...H, "Content-Type": "image/png", "X-Sign-Kind": "signature", "X-Sign-Mode": "draw" },
      body: png,
    });
    assert.equal(stored.status, 201);
    const item = await stored.json();
    const placed = await (await fetch(`${base}/api/signatures/place`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, page: 0, zoom: 1, rect: [60, 80, 200, 140] }),
    })).json();
    assert.equal(placed.kind, "signature");
    const saved = await (await fetch(`${base}/api/save`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })).json();
    assert.equal(saved.stamped, 1);
    assert.ok(fs.existsSync(path.join(dataDir, "signatures", `${item.id}.png`)));
  } finally {
    server.close();
  }
  const re = P.openBytes(new Uint8Array(fs.readFileSync(file)));
  assert.equal(re.loadPage(0).getAnnotations().length, 0);
  assert.ok(darkIn(re.loadPage(0), [60, 80, 200, 140], false) > 10);
});

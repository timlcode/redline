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
  labels.forEach((label, i) => {
    doc.insertPage(i, doc.addPage([0, 0, 612, 792], 0, res, `BT /F1 18 Tf 72 740 Td (${label}) Tj ET`));
  });
  return doc;
}

function addOutline(doc) {
  const uri = (page, y, zoom = 0) => doc.formatLinkURI({ type: "XYZ", chapter: 0, page, x: 72, y, width: 0, height: 0, zoom });
  const it = doc.outlineIterator();
  it.insert({ title: "Parent", uri: uri(0, 700, 1.5), page: 0 });
  it.prev();
  it.down();
  it.insert({ title: "Child", uri: uri(2, 400), page: 2 });
  it.prev();
  it.up();
  it.next();
  it.insert({ title: "Sibling", uri: uri(1, 100), page: 1 });
  return doc;
}

test("tabs keep each file's edits, and bookmarks jump to the saved page", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-tabs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const aPath = path.join(dir, "alpha.pdf");
  const bPath = path.join(dir, "beta.pdf");
  fs.writeFileSync(aPath, P.saveBytes(addOutline(docWithPages(["ALPHA", "BETA", "GAMMA"]))));
  fs.writeFileSync(bPath, P.saveBytes(docWithPages(["ONE", "TWO"])));
  const server = createServer({ autoOcrPages: 0, dataDir: path.join(dir, "data"), pickCommand: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { "X-Redline": "1", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const ct = res.headers.get("content-type") || "";
    return { status: res.status, body: ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };

  const emptyOutline = await api("GET", "/api/outline");
  assert.equal(emptyOutline.status, 404);

  const opened = await api("POST", "/api/open", { path: aPath });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.name, "alpha.pdf");
  assert.equal(opened.body.tabs.length, 1);
  const idA = opened.body.id;
  const mark = await api("POST", "/api/annots", { page: 0, tool: "box", zoom: 1, rect: [40, 40, 120, 90], color: "red" });
  assert.equal(mark.status, 201);

  const again = await api("POST", "/api/open", { path: aPath });
  assert.equal(again.body.reused, true);
  assert.equal(again.body.id, idA);
  assert.equal(again.body.tabs.length, 1);
  assert.equal((await api("GET", "/api/annots?page=0")).body.length, 1);

  const second = await api("POST", "/api/open", { path: bPath });
  assert.equal(second.status, 200);
  assert.equal(second.body.name, "beta.pdf");
  assert.equal(second.body.tabs.length, 2);
  const idB = second.body.id;
  assert.notEqual(idA, idB);
  assert.equal((await api("GET", "/api/annots?page=0")).body.length, 0, "the new file has no markup");
  assert.deepEqual((await api("GET", "/api/outline")).body.outline, []);

  const back = await api("POST", `/api/docs/${idA}/activate`);
  assert.equal(back.status, 200);
  assert.equal(back.body.id, idA);
  assert.equal(back.body.name, "alpha.pdf");
  assert.equal((await api("GET", "/api/annots?page=0", undefined, { "X-Doc-Id": idA })).body.length, 1);
  assert.equal((await api("GET", "/api/annots?page=0", undefined, { "X-Doc-Id": idB })).body.length, 0);

  const outline = (await api("GET", "/api/outline", undefined, { "X-Doc-Id": idA })).body.outline;
  assert.equal(outline[0].title, "Parent");
  assert.equal(outline[0].page, 0);
  assert.equal(outline[0].zoom, 1.5);
  assert.ok(outline[0].y < 150, `destination y ${outline[0].y} should be near the top`);
  assert.equal(outline[0].children[0].title, "Child");
  assert.equal(outline[0].children[0].page, 2);
  assert.ok(outline[0].children[0].y > outline[0].y);
  assert.equal(outline[1].title, "Sibling");
  assert.equal(outline[1].page, 1);

  const listed = await api("GET", "/api/docs");
  assert.deepEqual(listed.body.docs.map((d) => d.name), ["alpha.pdf", "beta.pdf"]);
  assert.equal(listed.body.docs.find((d) => d.id === idA).dirty, true);
  assert.equal(listed.body.docs.find((d) => d.id === idB).dirty, false);

  const blocked = await api("DELETE", `/api/docs/${idA}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "dirty");
  assert.equal((await api("GET", "/api/docs")).body.docs.length, 2);

  const closedB = await api("DELETE", `/api/docs/${idB}`);
  assert.equal(closedB.status, 200);
  assert.equal(closedB.body.tabs.length, 1);
  assert.equal(closedB.body.active, idA);
  assert.equal((await api("GET", "/api/doc")).body.name, "alpha.pdf");

  const closedA = await api("DELETE", `/api/docs/${idA}?discard=1`);
  assert.equal(closedA.status, 200);
  assert.equal(closedA.body.doc, null);
  assert.deepEqual(closedA.body.tabs, []);
  assert.equal((await api("GET", "/api/doc")).status, 404);
});

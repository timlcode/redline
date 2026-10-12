import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import * as P from "../lib/pdf.mjs";
import { createServer, backupPathFor } from "../server.mjs";

function decode(buf) {
  return PNG.sync.read(buf);
}

function px(png, x, y) {
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

const isRed = ([r, g, b]) => r > 180 && g < 90 && b < 90;
const isInk = ([r, g, b]) => r < 235 || g < 235 || b < 235;

function count(png, [x0, y0, x1, y1], pred) {
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(png.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(png.width, x1); x++) if (pred(px(png, x, y))) n++;
  }
  return n;
}

function bbox(png, region, pred) {
  const [x0, y0, x1, y1] = region || [0, 0, png.width, png.height];
  let b = null;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!pred(px(png, x, y))) continue;
      if (!b) b = [x, y, x, y];
      else b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
    }
  }
  return b;
}

function reopen(doc) {
  return P.openBytes(new Uint8Array(P.saveBytes(doc)));
}

const near = (a, b, tol = 1.5) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test("coordinate contract: PDF rect [40,752,120,792] renders at the TOP of the image", () => {
  const doc = P.newBlankDocument();
  const a = P.addSquareUser(doc, 0, [40, 752, 120, 792], [1, 0, 0], true);
  const raw = P.rawUserRect(doc, a.id);
  assert.ok(near(raw, [40, 752, 120, 792]), `stored /Rect is user space, got ${raw}`);

  const png = decode(P.renderPage(doc, 0, 1));
  assert.equal(png.width, 612);
  assert.equal(png.height, 792);
  assert.ok(isRed(px(png, 42, 2)), "red pixel near image (40,0)");
  assert.ok(isRed(px(png, 80, 20)), "red inside the top band");
  assert.ok(count(png, [40, 0, 120, 40], isRed) > 2500, "top band is filled red");
  assert.ok(!isRed(px(png, 80, 770)), "pixel (80,770) must NOT be red; if it is, the transform is upside down");
  assert.equal(count(png, [0, 400, 612, 792], isRed), 0, "no red anywhere in the bottom half");
});

test("image -> PDF helper: top-left pixel rect lands in the top band at zoom 1 and 2", () => {
  for (const zoom of [1, 2]) {
    const doc = P.newBlankDocument();
    const page = doc.loadPage(0);
    const user = P.imageRectToUser(page, zoom, [40 * zoom, 0, 120 * zoom, 40 * zoom]);
    assert.ok(near(user, [40, 752, 120, 792]), `zoom ${zoom}: got ${user}`);
    P.addSquareUser(doc, 0, user, [1, 0, 0], true);
    const png = decode(P.renderPage(doc, 0, zoom));
    assert.ok(count(png, [40 * zoom, 0, 120 * zoom, 40 * zoom], isRed) > 2500 * zoom * zoom * 0.9);
    assert.equal(count(png, [0, 400 * zoom, png.width, png.height], isRed), 0);

    // the tool path (createAnnot box) uses the same matrix
    const doc2 = P.newBlankDocument();
    P.createAnnot(doc2, { page: 0, tool: "box", zoom, rect: [40 * zoom, 2 * zoom, 120 * zoom, 40 * zoom], color: "red" });
    const png2 = decode(P.renderPage(doc2, 0, zoom));
    const b = bbox(png2, null, isRed);
    assert.ok(b && b[1] <= 4 * zoom && b[3] <= 42 * zoom, `box drawn at top, got ${b}`);
  }
});

// Each tool at a known image position, zoom 1.5, on an upright page.
const Z = 1.5;
const S = (r) => r.map((v) => v * Z);
const TOOLS = [
  { tool: "highlight", rect: S([40, 60, 260, 80]), region: [40, 60, 260, 80], type: "Highlight", kind: "highlight" },
  { tool: "note", point: S([400, 60]), contents: "Check this dim", region: [400, 60, 420, 80], type: "Text", kind: "note" },
  { tool: "text", rect: S([40, 110, 300, 150]), contents: "Field verify", region: [40, 110, 300, 150], type: "FreeText", kind: "text", color: "blue" },
  { tool: "pen", points: [S([40, 200]), S([80, 230]), S([120, 200]), S([160, 230])], region: [38, 196, 164, 234], type: "Ink", kind: "pen" },
  { tool: "line", from: S([40, 280]), to: S([260, 280]), region: [40, 276, 260, 284], type: "Line", kind: "line", color: "blue" },
  { tool: "arrow", from: S([40, 340]), to: S([260, 340]), region: [40, 336, 262, 344], type: "Line", kind: "arrow", color: "green" },
  { tool: "box", rect: S([320, 260, 500, 360]), region: [318, 258, 502, 362], type: "Square", kind: "box" },
  { tool: "stamp", stamp: "APPROVED", point: S([150, 430]), region: [50, 405, 250, 455], type: "FreeText", kind: "stamp" },
  { tool: "stamp", stamp: "REVISE", point: S([420, 430]), region: [340, 405, 500, 455], type: "FreeText", kind: "stamp" },
  { tool: "stamp", stamp: "REJECT", point: S([150, 530]), region: [50, 505, 250, 555], type: "FreeText", kind: "stamp" },
  { tool: "stamp", stamp: "FOR REVIEW", point: S([420, 530]), region: [300, 505, 545, 555], type: "FreeText", kind: "stamp" },
];

test("every tool creates a mark that survives save/reopen and is visible where placed", () => {
  const doc = P.newBlankDocument();
  const blank = decode(P.renderPage(doc, 0, 1));
  for (const t of TOOLS) assert.equal(count(blank, t.region, isInk), 0, `region for ${t.tool} starts blank`);

  const created = TOOLS.map((t) => P.createAnnot(doc, { ...t, page: 0, zoom: Z }));
  created.forEach((c, i) => assert.equal(c.kind, TOOLS[i].kind));

  const doc2 = reopen(doc);
  const list = P.listAnnots(doc2, 0);
  assert.equal(list.length, TOOLS.length);
  for (const t of TOOLS) {
    const hit = list.filter((a) => a.type === t.type && a.kind === t.kind);
    assert.ok(hit.length, `${t.tool} reopened as ${t.type}`);
    if (t.contents) assert.ok(hit.some((a) => a.contents === t.contents), `${t.tool} contents kept`);
    if (t.stamp) assert.ok(hit.some((a) => a.stamp === t.stamp && a.contents === t.stamp), `stamp ${t.stamp} kept`);
  }

  const png = decode(P.renderPage(doc2, 0, 1));
  for (const t of TOOLS) {
    const n = count(png, t.region, isInk);
    assert.ok(n > 40, `${t.tool}${t.stamp ? " " + t.stamp : ""} must be visible in ${t.region}, got ${n} px`);
  }

  // arrow head: pixels off the shaft axis near the tip, none near the tail
  const head = count(png, [235, 333, 262, 337], isInk) + count(png, [235, 343, 262, 347], isInk);
  const tail = count(png, [40, 333, 70, 337], isInk) + count(png, [40, 343, 70, 347], isInk);
  assert.ok(head > 20, `arrow head visible, got ${head}`);
  assert.equal(tail, 0, "plain tail end");

  // stamps read horizontally and are red
  for (const t of TOOLS.filter((x) => x.stamp)) {
    const b = bbox(png, t.region, isRed);
    assert.ok(b, `${t.stamp} has red pixels`);
    assert.ok(b[2] - b[0] > 2 * (b[3] - b[1]), `${t.stamp} is wider than tall: ${b}`);
  }

  // highlight is yellow
  const [r, g, b] = px(png, 150, 70);
  assert.ok(r > 200 && g > 170 && b < 120, `highlight yellow, got ${[r, g, b]}`);
});

test("select tool operations: move, edit contents, delete", () => {
  const doc = P.newBlankDocument();
  const box = P.createAnnot(doc, { page: 0, tool: "box", zoom: 1, rect: [100, 100, 200, 200], color: "red" });
  const moved = P.patchAnnot(doc, box.id, { dx: 200, dy: 300, zoom: 1 });
  assert.ok(Math.abs(moved.rect[0] - box.rect[0] - 200) < 0.5 && Math.abs(moved.rect[1] - box.rect[1] - 300) < 0.5);
  let png = decode(P.renderPage(doc, 0, 1));
  assert.equal(count(png, [95, 95, 205, 205], isRed), 0, "old spot cleared");
  assert.ok(count(png, [295, 395, 405, 505], isRed) > 100, "new spot drawn");

  for (const tool of ["highlight", "pen", "arrow"]) {
    const spec =
      tool === "pen"
        ? { points: [[50, 600], [100, 650], [150, 600]] }
        : tool === "arrow"
          ? { from: [50, 600], to: [150, 600] }
          : { rect: [50, 600, 150, 620] };
    const d = P.newBlankDocument();
    const a = P.createAnnot(d, { page: 0, tool, zoom: 1, color: "red", ...spec });
    const m = P.patchAnnot(d, a.id, { dx: 0, dy: -400, zoom: 2 });
    assert.ok(Math.abs(m.rect[1] - (a.rect[1] - 200)) < 1, `${tool} moved by dy/zoom: ${a.rect} -> ${m.rect}`);
    png = decode(P.renderPage(d, 0, 1));
    assert.ok(count(png, [40, 380, 160, 460], isInk) > 20, `${tool} visible at new spot`);
  }

  const txt = P.createAnnot(doc, { page: 0, tool: "text", zoom: 1, rect: [40, 40, 300, 80], contents: "one" });
  assert.equal(P.patchAnnot(doc, txt.id, { contents: "two" }).contents, "two");
  P.deleteAnnot(doc, box.id);
  assert.equal(P.listAnnots(reopen(doc), 0).length, 1);
});

test("rotation: marks land where the pointer was, before and after rotate", () => {
  const doc = P.newBlankDocument();
  // draw-then-rotate: top-left mark rotates with the drawing (90 cw -> top-right)
  const early = P.createAnnot(doc, { page: 0, tool: "box", zoom: 1, rect: [40, 2, 120, 40], color: "red" });
  assert.equal(P.rotatePage(doc, 0, 90), 90);
  let png = decode(P.renderPage(doc, 0, 1));
  assert.equal(png.width, 792);
  assert.equal(png.height, 612);
  let b = bbox(png, null, isRed);
  assert.ok(b && b[0] >= 748 && b[1] >= 36 && b[1] <= 44 && b[3] <= 124, `early mark at top-right, got ${b}`);
  const listed = P.listAnnots(doc, 0).find((a) => a.id === early.id);
  assert.ok(Math.abs(listed.rect[0] - b[0]) <= 3 && Math.abs(listed.rect[1] - b[1]) <= 3, "listed bounds match pixels");

  // rotate-then-draw: every geometry type, at zoom 2, lands at the pointer
  const Z2 = 2;
  const marks = [
    { tool: "box", rect: [300, 300, 400, 380], region: [298, 298, 402, 382] },
    { tool: "highlight", rect: [450, 300, 600, 320], region: [450, 300, 600, 320] },
    { tool: "pen", points: [[450, 400], [500, 440], [550, 400]], region: [446, 396, 554, 444] },
    { tool: "arrow", from: [100, 500], to: [300, 500], region: [100, 494, 302, 506] },
    { tool: "stamp", stamp: "REVISE", point: [650, 520], region: [560, 495, 740, 545] },
    { tool: "text", rect: [100, 150, 300, 190], contents: "Rotated note", region: [100, 150, 300, 190] },
    { tool: "note", point: [650, 200], contents: "n", region: [650, 200, 670, 220] },
  ];
  for (const mk of marks) {
    const scaled = { ...mk };
    for (const k of ["rect", "point", "from", "to"]) if (mk[k]) scaled[k] = mk[k].map((v) => v * Z2);
    if (mk.points) scaled.points = mk.points.map((p) => p.map((v) => v * Z2));
    P.createAnnot(doc, { ...scaled, page: 0, zoom: Z2, color: "red" });
  }
  png = decode(P.renderPage(reopen(doc), 0, 1));
  for (const mk of marks) {
    const n = count(png, mk.region, isInk);
    assert.ok(n > 40, `${mk.tool} after rotate visible at ${mk.region}, got ${n}`);
  }
  b = bbox(png, marks[0].region, isRed);
  assert.ok(near(b, [300, 300, 400, 380], 3), `rotated box exact, got ${b}`);
  // stamp placed after rotate reads left-to-right (wider than tall)
  b = bbox(png, marks[4].region, isRed);
  assert.ok(b[2] - b[0] > 2 * (b[3] - b[1]), `stamp upright after rotate: ${b}`);

  // rotate the other way back to upright, the early mark returns to top-left
  P.rotatePage(doc, 0, -90);
  png = decode(P.renderPage(doc, 0, 1));
  assert.equal(png.width, 612);
  assert.ok(count(png, [40, 0, 120, 42], isRed) > 200);
});

test("pages: insert, move, delete keep annotations with their page", () => {
  const doc = P.newBlankDocument(3);
  P.createAnnot(doc, { page: 1, tool: "text", zoom: 1, rect: [50, 50, 300, 90], contents: "page-B" });
  P.createAnnot(doc, { page: 2, tool: "text", zoom: 1, rect: [50, 50, 300, 90], contents: "page-C" });
  const where = (d, label) => {
    for (let i = 0; i < d.countPages(); i++) if (P.listAnnots(d, i).some((a) => a.contents === label)) return i;
    return -1;
  };

  assert.equal(P.insertBlankPage(doc, 0), 0);
  assert.equal(doc.countPages(), 4);
  assert.equal(where(doc, "page-B"), 2);
  assert.equal(P.listAnnots(doc, 0).length, 0, "inserted page is blank");

  P.movePage(doc, 2, 0);
  assert.equal(where(doc, "page-B"), 0);
  assert.equal(where(doc, "page-C"), 3);

  P.rotatePage(doc, 0, 90);
  P.deletePage(doc, 3);
  assert.equal(doc.countPages(), 3);
  assert.equal(where(doc, "page-C"), -1);

  const d2 = reopen(doc);
  assert.equal(d2.countPages(), 3);
  assert.equal(where(d2, "page-B"), 0);
  assert.equal(P.getRotate(d2, 0), 90);
  const png = decode(P.renderPage(d2, 0, 1));
  assert.ok(count(png, [0, 0, png.width, png.height], isInk) > 100, "moved page still shows its text box");

  const sized = P.newBlankDocument(1, 1224, 792);
  P.insertBlankPage(sized, 1, 0);
  assert.deepEqual(sized.loadPage(1).getBounds(), [0, 0, 1224, 792]);
  assert.throws(() => P.deletePage(P.newBlankDocument(1), 0));
});

test("HTTP API end to end: open, every tool, save with backup, save-as, reopen", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "redline-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const server = createServer({ autoOcrPages: 0, dataDir: path.join(tmp, "data"), pickCommand: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, body, headers = { "X-Redline": "1" }) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const ct = res.headers.get("content-type") || "";
    return { status: res.status, body: ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };

  const health = await api("GET", "/api/health");
  assert.equal(health.body.ok, true);
  assert.equal(health.body.version, JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url))).version);
  const html = await api("GET", "/");
  assert.match(html.body.toString(), /Redline/);
  assert.equal((await api("GET", "/api/doc")).status, 404);

  const src = path.join(tmp, "sheet A-101.pdf");
  const original = P.saveBytes(P.newBlankDocument(2, 792, 612));
  fs.writeFileSync(src, original);
  fs.writeFileSync(path.join(tmp, "fake.pdf"), "hello");

  assert.equal((await api("POST", "/api/open", { path: src }, {})).status, 403, "no X-Redline -> rejected");
  assert.equal((await api("POST", "/api/open", { path: path.join(tmp, "fake.pdf") })).status, 400);
  assert.equal((await api("POST", "/api/open", { path: path.join(tmp, "missing.pdf") })).status, 404);
  const opened = await api("POST", "/api/open", { path: src });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.pageCount, 2);
  assert.equal(opened.body.width, 792);
  assert.equal(opened.body.dirty, false);
  assert.equal(opened.body.sourcePath, src);
  assert.equal(opened.body.name, "sheet A-101.pdf");

  for (const t2 of TOOLS) {
    const r = await api("POST", "/api/annots", { ...t2, page: 0, zoom: Z });
    assert.equal(r.status, 201, `${t2.tool}: ${JSON.stringify(r.body)}`);
  }
  assert.equal((await api("POST", "/api/annots", { page: 0, tool: "box", zoom: 1, rect: [1, 1, 2, 2] })).status, 400);
  const listed = (await api("GET", "/api/annots?page=0")).body;
  assert.equal(listed.length, TOOLS.length);
  assert.equal((await api("GET", "/api/doc")).body.dirty, true);

  const pagePng = decode((await api("GET", "/api/page/0?zoom=1")).body);
  assert.equal(pagePng.width, 792);
  for (const t2 of TOOLS) assert.ok(count(pagePng, t2.region, isInk) > 40, `${t2.tool} visible over HTTP`);
  const big = decode((await api("GET", "/api/page/0?zoom=99")).body);
  assert.equal(big.width, 792 * 4, "zoom clamped to 4");
  assert.ok(decode((await api("GET", "/api/thumbs/1")).body).width <= 200);

  const box = listed.find((a) => a.kind === "box");
  assert.equal((await api("PATCH", `/api/annots/${box.id}`, { dx: 0, dy: 30, zoom: 1 })).status, 200);
  const extra = (await api("POST", "/api/annots", { page: 1, tool: "box", zoom: 1, rect: [10, 10, 60, 60] })).body;
  assert.equal((await api("DELETE", `/api/annots/${extra.id}`)).status, 200);
  assert.equal((await api("DELETE", `/api/annots/${extra.id}`)).status, 404);

  const ins = await api("POST", "/api/pages/insert", { at: 2 });
  assert.equal(ins.body.pageCount, 3);
  assert.equal((await api("POST", "/api/pages/rotate", { page: 2, delta: 90 })).body.rotate, 90);
  assert.equal((await api("POST", "/api/pages/move", { from: 2, to: 1 })).body.pageCount, 3);
  assert.equal((await api("POST", "/api/pages/delete", { page: 1 })).body.pageCount, 2);

  const saved = await api("POST", "/api/save", {});
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const bak = backupPathFor(src);
  assert.equal(bak, path.join(tmp, "sheet A-101.redline-bak.pdf"));
  assert.deepEqual(fs.readFileSync(bak), original, "backup is the untouched original");
  assert.equal((await api("GET", "/api/doc")).body.dirty, false);
  await api("POST", "/api/annots", { page: 1, tool: "box", zoom: 1, rect: [10, 10, 60, 60] });
  await api("POST", "/api/save", {});
  assert.deepEqual(fs.readFileSync(bak), original, "backup not overwritten by a second save");
  assert.deepEqual(
    fs.readdirSync(tmp).filter((f) => f.endsWith(".tmp")),
    [],
    "no temp files left behind",
  );

  const proof = "/tmp/redline-proof.pdf";
  fs.rmSync(proof, { force: true });
  fs.rmSync(backupPathFor(proof), { force: true });
  const sa = await api("POST", "/api/save-as", { path: proof });
  assert.equal(sa.status, 200, JSON.stringify(sa.body));
  assert.equal((await api("GET", "/api/doc")).body.sourcePath, proof);

  for (const file of [src, proof]) {
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    const d = P.openBytes(new Uint8Array(bytes));
    assert.equal(d.countPages(), 2);
    const kinds = P.listAnnots(d, 0).map((a) => a.kind).sort();
    assert.deepEqual(kinds, ["arrow", "box", "highlight", "line", "note", "pen", "stamp", "stamp", "stamp", "stamp", "text"]);
    const stamps = P.listAnnots(d, 0).filter((a) => a.stamp).map((a) => a.stamp).sort();
    assert.deepEqual(stamps, ["APPROVED", "FOR REVIEW", "REJECT", "REVISE"]);
    assert.equal(P.listAnnots(d, 1).length, 1);
    const png = decode(P.renderPage(d, 0, 1));
    for (const t2 of TOOLS.filter((x) => x.tool !== "box")) assert.ok(count(png, t2.region, isInk) > 40, `${t2.tool} in saved file`);
  }

  const dl = await api("GET", "/api/download");
  assert.equal(dl.body.subarray(0, 5).toString(), "%PDF-");

  const up = await fetch(base + "/api/open-upload", {
    method: "POST",
    headers: { "X-Redline": "1", "Content-Type": "application/pdf", "X-Filename": "up.pdf" },
    body: original,
  });
  const upBody = await up.json();
  assert.equal(upBody.sourcePath, null);
  assert.equal(upBody.pageCount, 2);
  assert.equal((await api("POST", "/api/save", {})).status, 400, "save without source path is 400");

  assert.equal((await api("POST", "/api/pick", { mode: "open" })).status, 501, "picker disabled in tests");
  const evilStatus = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: server.address().port, path: "/api/health", headers: { Host: "evil.example:4521" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(evilStatus, 403, "foreign Host header rejected");
});

test("send API: routes, live-markup snapshot, validation", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "redline-send-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const calls = [];
  const snap = (file) => ({ file, name: path.basename(file), bytes: fs.readFileSync(file) });
  const sender = {
    sendConfig: () => ({ email: { ready: true, from: "me@x.com" }, telegram: { ready: true }, localsend: { ready: true } }),
    lanInterfaces: () => [],
    openMailSetup: () => ({ ok: true }),
    discoverLocalSend: async () => [{ ip: "10.0.0.9", port: 53317, protocol: "https", alias: "Phone" }],
    sendEmail: async (file, b) => (calls.push({ via: "email", ...snap(file), b }), { ok: true, via: "email" }),
    sendTelegram: async (file, b) => (calls.push({ via: "telegram", ...snap(file), b }), { ok: true, via: "telegram" }),
    sendToMac: async (file, mac) => (calls.push({ via: "mac", ...snap(file), mac }), { ok: true, via: "mac" }),
    sendLocalSend: async (file, dev) => (calls.push({ via: "localsend", ...snap(file), dev }), { ok: true, via: "localsend" }),
  };
  const server = createServer({ autoOcrPages: 0, dataDir: path.join(tmp, "data"), pickCommand: false, sender });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { "X-Redline": "1", "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await api("POST", "/api/send", { via: "telegram" })).status, 404, "no doc open");
  const src = path.join(tmp, "Sheet 1.pdf");
  fs.writeFileSync(src, P.saveBytes(P.newBlankDocument(1)));
  await api("POST", "/api/open", { path: src });
  await api("POST", "/api/annots", { page: 0, zoom: 1, tool: "stamp", stamp: "APPROVED", point: [100, 100] });

  assert.equal((await api("GET", "/api/send/config")).body.name, "Sheet 1.pdf");
  assert.equal((await api("GET", "/api/send/localsend/devices")).body.devices[0].alias, "Phone");
  for (const via of ["email", "mac", "telegram", "localsend"]) {
    const r = await api("POST", "/api/send", { via, subject: "Sheet 1", mac: "parker", caption: "hi", device: { ip: "10.0.0.9" } });
    assert.equal(r.status, 200, via);
  }
  assert.equal(calls.length, 4);
  for (const c of calls) {
    assert.equal(c.name, "Sheet 1.pdf");
    const doc = P.openBytes(new Uint8Array(c.bytes));
    assert.equal(P.listAnnots(doc, 0).length, 1, `${c.via} gets unsaved markup`);
  }
  assert.equal(calls[0].b.subject, "Sheet 1");
  assert.equal(calls[1].mac, "parker");
  assert.equal(calls[3].dev.ip, "10.0.0.9");
  assert.equal(new Set(calls.map((c) => c.file)).size, 4, "each send gets its own snapshot (open drafts keep theirs)");
  assert.ok(calls.every((c) => fs.existsSync(c.file)), "earlier snapshots are not deleted");
  assert.equal((await api("POST", "/api/send", { via: "fax" })).status, 400);
});

test("LocalSend client: mTLS prepare-upload + upload against a fake receiver", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "redline-ls-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  process.env.REDLINE_DATA_DIR = path.join(tmp, "data");
  const S = await import(`../lib/send.mjs?ls=${Date.now()}`);
  const { execFileSync } = await import("node:child_process");
  const https = await import("node:https");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(tmp, "k.pem"), "-out", path.join(tmp, "c.pem"), "-days", "1", "-subj", "/CN=fake"], { stdio: "ignore" });
  let got = null;
  let peerCert = false;
  const srv = https.createServer(
    { key: fs.readFileSync(path.join(tmp, "k.pem")), cert: fs.readFileSync(path.join(tmp, "c.pem")), requestCert: true, rejectUnauthorized: false },
    (req, res) => {
      peerCert = peerCert || !!req.socket.getPeerCertificate()?.raw;
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        if (req.url.startsWith("/api/localsend/v2/prepare-upload")) {
          const j = JSON.parse(body);
          const id = Object.keys(j.files)[0];
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ sessionId: "s1", files: { [id]: "tok" } }));
        }
        if (req.url.startsWith("/api/localsend/v2/upload")) {
          const q = new URL(req.url, "https://x").searchParams;
          assert.equal(q.get("token"), "tok");
          got = body;
          res.writeHead(200);
          return res.end();
        }
        res.writeHead(404);
        res.end();
      });
    },
  );
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const file = path.join(tmp, "x.pdf");
  fs.writeFileSync(file, P.saveBytes(P.newBlankDocument(1)));
  const r = await S.sendLocalSend(file, { ip: "127.0.0.1", port: srv.address().port, protocol: "https", alias: "Fake" });
  assert.equal(r.ok, true);
  assert.ok(peerCert, "client presented a certificate (mTLS)");
  assert.deepEqual(got, fs.readFileSync(file));
  await assert.rejects(S.sendLocalSend(file, { ip: "not-an-ip" }), /Pick a LocalSend device/);
});

test("Thunderbird compose: finds the work identity and builds the -compose args", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "redline-tb-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const prof = path.join(tmp, "home/.thunderbird/abc.default-release");
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(prof, "prefs.js"), 'user_pref("mail.identity.id1.useremail", "user@example.com");\nuser_pref("mail.identity.id3.useremail", "user@example.com");\n');
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const log = path.join(tmp, "args.txt");
  fs.writeFileSync(path.join(bin, "thunderbird"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${log}\n`, { mode: 0o755 });
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  process.env.HOME = path.join(tmp, "home");
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => {
    process.env.HOME = oldHome;
    process.env.PATH = oldPath;
  });
  const S = await import(`../lib/send.mjs?tb=${Date.now()}`);
  assert.deepEqual(S.workIdentity()?.id, "id3");
  const r = await S.sendEmail("/tmp/out/Sheet A's.pdf", { subject: "Sheet A's" });
  assert.equal(r.accountReady, true);
  for (let i = 0; i < 50 && !fs.existsSync(log); i++) await new Promise((res) => setTimeout(res, 50));
  const args = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(args[0], "-compose");
  assert.match(args[1], /attachment='file:\/\/\/tmp\/out\/Sheet%20A/);
  assert.match(args[1], /preselectid='id3'/);
  assert.match(args[1], /from='user@example.com'/);
  assert.doesNotMatch(args[1].replace(/='[^']*'/g, ""), /'/, "quotes inside values are neutralised");
});

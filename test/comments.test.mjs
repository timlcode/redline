import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as mupdf from "mupdf";
import * as P from "../lib/pdf.mjs";
import { createServer } from "../server.mjs";

function blank(pages = 2) {
  const doc = new mupdf.PDFDocument();
  for (let i = 0; i < pages; i++) doc.insertPage(i, doc.addPage([0, 0, 612, 792], 0, {}, " "));
  return doc;
}
const reopen = (doc) => mupdf.Document.openDocument(new Uint8Array(doc.saveToBuffer("").asUint8Array()), "application/pdf").asPDF();

test("author, dates, replies, listing order, delete cascades", () => {
  P.setDefaultAuthor("Ada Reviewer");
  const doc = blank(2);
  const box = P.createAnnot(doc, { page: 1, tool: "box", zoom: 1, rect: [50, 400, 150, 450] });
  const note = P.createAnnot(doc, { page: 0, tool: "note", zoom: 1, point: [100, 100], contents: "Check this" });
  const stamp = P.createAnnot(doc, { page: 0, tool: "stamp", zoom: 1, point: [300, 300], stamp: "REVISE" });
  const other = P.createAnnot(doc, { page: 0, tool: "box", zoom: 1, rect: [10, 10, 40, 40], author: "Blake" });
  assert.equal(note.author, "Ada Reviewer");
  assert.equal(other.author, "Blake");
  assert.ok(note.created && note.modified, "dates set");
  const r1 = P.replyToAnnot(doc, note.id, "Will do", "Casey");
  const r2 = P.replyToAnnot(doc, note.id, "Done", "Ada Reviewer");
  assert.equal(r1.kind, "reply");
  assert.equal(r1.inReplyTo, note.id);
  const all = P.listAllAnnots(reopen(doc));
  assert.deepEqual(all.map((a) => [a.page, a.kind]), [[0, "box"], [0, "note"], [0, "stamp"], [1, "box"]]);
  const n = all.find((a) => a.kind === "note");
  assert.equal(n.replies.length, 2);
  assert.deepEqual(n.replies.map((r) => r.contents), ["Will do", "Done"]);
  assert.equal(n.replies[0].author, "Casey");
  // page overlay list still shows replies as kind reply (client hides them), and they are hidden flags
  const pageList = P.listAnnots(doc, 0);
  assert.equal(pageList.filter((a) => a.kind === "reply").length, 2);
  // deleting the note removes its replies
  P.deleteAnnot(doc, note.id);
  assert.equal(P.listAnnots(doc, 0).length, 2);
  assert.equal(stamp.stamp, "REVISE");
  void box;
});

test("CSV and summary PDF", () => {
  P.setDefaultAuthor("Ada");
  const doc = blank(2);
  const t = P.createAnnot(doc, { page: 0, tool: "text", zoom: 1, rect: [50, 50, 250, 90], contents: 'Verify "all" dims, see note' });
  P.replyToAnnot(doc, t.id, "Verified 10/12", "Blake");
  P.createAnnot(doc, { page: 1, tool: "stamp", zoom: 1, point: [300, 300], stamp: "APPROVED" });
  const csv = P.annotsToCsv(doc, "job.pdf");
  const lines = csv.trim().split("\r\n");
  assert.equal(lines[0], "File,Page,Type,Author,Date,Comment,Reply to");
  assert.equal(lines.length, 4);
  assert.match(lines[1], /^job\.pdf,1,Text box,Ada,\d{4}-\d\d-\d\d \d\d:\d\d,"Verify ""all"" dims, see note",$/);
  assert.match(lines[2], /^job\.pdf,1,Reply,Blake,.*,Verified 10\/12,/);
  assert.match(lines[3], /^job\.pdf,2,Stamp,Ada,.*,APPROVED,$/);
  const pdf = P.annotsSummaryPdf(doc, "job.pdf");
  assert.equal(pdf.countPages(), 1);
  const text = pdf.loadPage(0).toStructuredText("").asText();
  assert.match(text, /Comment summary/);
  assert.match(text, /Page 1/);
  assert.match(text, /Text box · Ada/);
  assert.match(text, /Verify "all" dims, see note/);
  assert.match(text, /Reply · Blake/);
  assert.match(text, /Page 2/);
  assert.match(text, /APPROVED/);
  // many comments paginate
  for (let i = 0; i < 80; i++) P.createAnnot(doc, { page: 1, tool: "note", zoom: 1, point: [20 + i, 20], contents: `n${i}` });
  assert.ok(P.annotsSummaryPdf(doc).countPages() >= 3);
});

test("server: settings author, replies, summaries, export", { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-cm-"));
  const file = path.join(dir, "t.pdf");
  fs.writeFileSync(file, new Uint8Array(blank(1).saveToBuffer("").asUint8Array()));
  const server = createServer({ dataDir: path.join(dir, "data"), pickCommand: false, autoOcrPages: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { "X-Redline": "1", "Content-Type": "application/json" };
  const j = async (res) => res.json();
  const post = (p, body) => fetch(`${base}${p}`, { method: "POST", headers: H, body: JSON.stringify(body || {}) });
  try {
    let s = await j(await fetch(`${base}/api/settings`));
    assert.ok(typeof s.author === "string");
    s = await j(await post("/api/settings", { author: "  Ada Reviewer  " }));
    assert.equal(s.author, "Ada Reviewer");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "data", "settings.json"), "utf8")).author, "Ada Reviewer");
    await post("/api/open", { path: file });
    const a = await j(await post("/api/annots", { page: 0, tool: "note", zoom: 1, point: [100, 100], contents: "First" }));
    assert.equal(a.author, "Ada Reviewer");
    const r = await j(await post(`/api/annots/${a.id}/reply`, { contents: "Second" }));
    assert.equal(r.kind, "reply");
    assert.equal((await post(`/api/annots/${a.id}/reply`, { contents: "  " })).status, 400);
    const all = await j(await fetch(`${base}/api/annots/all`));
    assert.equal(all.length, 1);
    assert.equal(all[0].replies[0].contents, "Second");
    assert.equal((await j(await fetch(`${base}/api/doc`))).undoLabel, "reply");
    const csv = await (await fetch(`${base}/api/annots/summary.csv`)).text();
    assert.match(csv, /t\.pdf,1,Note,Ada Reviewer,.*,First,/);
    const pdfRes = await fetch(`${base}/api/annots/summary.pdf`);
    assert.equal(pdfRes.headers.get("content-type"), "application/pdf");
    assert.match(pdfRes.headers.get("content-disposition"), /t comments\.pdf/);
    const out = path.join(dir, "sum");
    const e = await j(await post("/api/annots/export", { format: "csv", path: out }));
    assert.equal(e.path, out + ".csv");
    assert.match(fs.readFileSync(e.path, "utf8"), /Second/);
    const e2 = await j(await post("/api/annots/export", { format: "pdf", path: out }));
    assert.ok(fs.statSync(e2.path).size > 500);
    // undo the reply, the note survives
    await post("/api/undo");
    assert.equal((await j(await fetch(`${base}/api/annots/all`)))[0].replies, undefined);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as mupdf from "mupdf";
import * as P from "../lib/pdf.mjs";
import { createServer } from "../server.mjs";

const USER = "open,me";
const OWNER = 'owner"pw';
const MARK = "Section 033000 concrete";

function textDoc() {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const res = doc.addObject({ Font: { F1: font } });
  doc.insertPage(0, doc.addPage([0, 0, 612, 792], 0, res, `BT /F1 18 Tf 72 700 Td (${MARK}) Tj ET`));
  return doc;
}

function encrypt(doc, spec) {
  return P.saveBytes(doc, P.normalizeProtection({ mode: "password", ...spec }));
}

function textOf(doc) {
  return doc.loadPage(0).toStructuredText("").asText();
}

test("user password is required, rejected when wrong, and accepted when right", () => {
  const bytes = encrypt(textDoc(), { userPassword: USER, ownerPassword: OWNER, print: false, copy: false, edit: false });
  assert.equal(Buffer.from(bytes).includes(Buffer.from(USER)), false);
  assert.equal(Buffer.from(bytes).includes(Buffer.from(OWNER)), false);

  assert.throws(() => P.openBytes(bytes), (e) => e.code === "password-required" && e.status === 401 && e.message === "This PDF needs a password to open");
  assert.throws(() => P.openBytes(bytes, "nope"), (e) => e.code === "password" && e.message === "Incorrect password" && !e.message.includes(USER));

  const doc = P.openBytes(bytes, USER);
  assert.match(doc.getMetaData("encryption"), /AES/);
  assert.match(doc.getMetaData("encryption"), /256/);
  assert.match(textOf(doc), /concrete/);
  assert.equal(doc.hasPermission("print"), false);
  assert.equal(doc.hasPermission("copy"), false);
  assert.equal(doc.hasPermission("edit"), false);

  const owner = P.openBytes(bytes, OWNER);
  assert.equal(owner.hasPermission("print"), true);
  assert.equal(owner.hasPermission("edit"), true);
  assert.match(textOf(owner), /concrete/);
});

test("permissions-only file opens with no password and keeps restrictions", () => {
  const bytes = encrypt(textDoc(), { userPassword: "", ownerPassword: "only-owner", print: true, copy: false, edit: false });
  const doc = P.openBytes(bytes);
  assert.equal(doc.needsPassword(), false);
  assert.match(textOf(doc), /concrete/);
  assert.equal(doc.hasPermission("print"), true);
  assert.equal(doc.hasPermission("copy"), false);
  assert.equal(doc.hasPermission("edit"), false);
  const info = P.protectionInfo(doc);
  assert.equal(info.encrypted, true);

  const wrong = P.openBytes(bytes, "not-owner");
  assert.match(textOf(wrong), /concrete/);
  assert.equal(wrong.hasPermission("copy"), false);

  const owner = P.openBytes(bytes, "only-owner");
  assert.equal(owner.hasPermission("copy"), true);
  assert.equal(owner.hasPermission("edit"), true);
});

test("save can keep protection, remove it, or replace it with AES-256", () => {
  const bytes = encrypt(textDoc(), { userPassword: USER, ownerPassword: OWNER, print: false, copy: true, edit: true });
  const doc = P.openBytes(bytes, USER);
  P.createAnnot(doc, { page: 0, tool: "box", zoom: 1, rect: [40, 40, 120, 80], color: "red" });

  const kept = P.saveBytes(doc);
  const keptDoc = P.openBytes(kept, USER);
  assert.equal(keptDoc.countPages(), 1);
  assert.equal(P.listAnnots(keptDoc, 0).some((a) => a.kind === "box"), true);
  assert.equal(keptDoc.hasPermission("print"), false);
  assert.throws(() => P.openBytes(kept), (e) => e.code === "password-required");

  const removed = P.saveBytes(doc, P.normalizeProtection({ mode: "none" }));
  assert.equal(P.protectionInfo(doc).encrypted, false);
  const open = P.openBytes(removed);
  assert.equal(P.protectionInfo(open).encrypted, false);
  assert.match(textOf(open), /concrete/);
  assert.equal(P.listAnnots(open, 0).some((a) => a.kind === "box"), true);

  const nextUser = "next-open";
  const nextOwner = "next-owner";
  const replaced = P.saveBytes(doc, P.normalizeProtection({
    mode: "password",
    userPassword: nextUser,
    ownerPassword: nextOwner,
    print: true,
    copy: false,
    edit: false,
  }));
  assert.equal(Buffer.from(replaced).includes(Buffer.from(nextUser)), false);
  assert.throws(() => P.openBytes(replaced, USER), (e) => e.code === "password");
  assert.equal(P.protectionInfo(doc).encrypted, true);
  assert.equal(P.protectionInfo(doc).copy, false);
  assert.equal(P.protectionInfo(doc).edit, false);
  const again = P.openBytes(replaced, nextUser);
  assert.match(again.getMetaData("encryption"), /256-bit AES/);
  assert.equal(again.hasPermission("copy"), false);
  assert.equal(again.hasPermission("edit"), false);
  assert.equal(P.openBytes(replaced, nextOwner).hasPermission("edit"), true);
  // A later plain save keeps the new crypt.
  assert.throws(() => P.openBytes(P.saveBytes(again)), (e) => e.code === "password-required");
  assert.throws(() => P.openBytes(P.saveBytes(again), "nope"), (e) => e.code === "password");
  assert.match(textOf(P.openBytes(P.saveBytes(again), nextUser)), /concrete/);
});

test("normalizeProtection refuses a leaked or ambiguous password choice", () => {
  assert.equal(P.normalizeProtection(undefined).mode, "keep");
  assert.equal(P.normalizeProtection({ mode: "password", userPassword: "", ownerPassword: "", print: true, copy: true, edit: true }).mode, "none");
  assert.throws(
    () => P.normalizeProtection({ mode: "password", userPassword: "same", ownerPassword: "same", print: false }),
    (e) => e.status === 400 && !String(e.message).includes("same"),
  );
  assert.throws(
    () => P.normalizeProtection({ mode: "password", userPassword: "", ownerPassword: "", print: false }),
    /permissions password/i,
  );
});

test("HTTP open prompts with a clear retry, then save can change protection", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "redline-pw-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const seen = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) {
    console[k] = (...args) => {
      const line = args.map(String).join(" ");
      if (line.includes(USER) || line.includes(OWNER)) seen.push(line);
      orig[k](...args);
    };
  }
  t.after(() => Object.assign(console, orig));

  const server = createServer({ autoOcrPages: 0, dataDir: path.join(tmp, "data"), pickCommand: false });
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
    const parsed = ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: parsed };
  };

  const src = path.join(tmp, "sealed.pdf");
  fs.writeFileSync(src, encrypt(textDoc(), { userPassword: USER, ownerPassword: OWNER, print: false, copy: false, edit: true }));

  const missing = await api("POST", "/api/open", { path: src });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.code, "password-required");
  assert.equal(JSON.stringify(missing.body).includes(USER), false);

  const wrong = await api("POST", "/api/open", { path: src, password: "wrong-password" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, "password");
  assert.equal(wrong.body.error, "Incorrect password");
  assert.equal(JSON.stringify(wrong.body).includes("wrong-password"), false);

  const opened = await api("POST", "/api/open", { path: src, password: USER });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.protection.encrypted, true);
  assert.equal(opened.body.protection.userPassword, true);
  assert.equal(opened.body.protection.print, false);
  assert.equal(JSON.stringify(opened.body).includes(USER), false);
  const pageText = await fetch(`${base}/api/text?page=0`);
  assert.match(await pageText.text(), /concrete/);

  const upload = await fetch(`${base}/api/open-upload`, {
    method: "POST",
    headers: { "X-Redline": "1", "X-Filename": "upload.pdf", "X-Password": encodeURIComponent(USER) },
    body: fs.readFileSync(src),
  });
  assert.equal(upload.status, 200);

  const kept = await api("POST", "/api/save-as", { path: path.join(tmp, "kept.pdf"), protection: { mode: "keep" } });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.throws(() => P.openBytes(fs.readFileSync(path.join(tmp, "kept.pdf"))), (e) => e.code === "password-required");

  const removed = await api("POST", "/api/save-as", { path: path.join(tmp, "open.pdf"), protection: { mode: "none" } });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.protection.encrypted, false);
  assert.match(textOf(P.openBytes(fs.readFileSync(path.join(tmp, "open.pdf")))), /concrete/);

  const locked = await api("POST", "/api/save-as", {
    path: path.join(tmp, "locked.pdf"),
    protection: { mode: "password", userPassword: "fresh-open", ownerPassword: "fresh-owner", print: true, copy: false, edit: false },
  });
  assert.equal(locked.status, 200, JSON.stringify(locked.body));
  assert.equal(locked.body.protection.userPassword, true);
  assert.equal(locked.body.protection.copy, false);
  const lockedBytes = fs.readFileSync(path.join(tmp, "locked.pdf"));
  assert.equal(lockedBytes.includes(Buffer.from("fresh-open")), false);
  assert.equal(P.openBytes(lockedBytes, "fresh-open").hasPermission("copy"), false);

  const ownerOnly = encrypt(textDoc(), { userPassword: "", ownerPassword: "desk-owner", print: false, copy: true, edit: true });
  fs.writeFileSync(path.join(tmp, "perms.pdf"), ownerOnly);
  const perms = await api("POST", "/api/open", { path: path.join(tmp, "perms.pdf") });
  assert.equal(perms.status, 200);
  assert.equal(perms.body.protection.encrypted, true);
  assert.equal(perms.body.protection.userPassword, false);
  assert.equal(perms.body.protection.print, false);

  const settingsPath = path.join(tmp, "data", "settings.json");
  if (fs.existsSync(settingsPath)) assert.equal(fs.readFileSync(settingsPath, "utf8").includes(USER), false);
  for (const file of fs.readdirSync(path.join(tmp, "data"), { recursive: true })) {
    const fp = path.join(tmp, "data", String(file));
    if (!fs.statSync(fp).isFile()) continue;
    const raw = fs.readFileSync(fp);
    assert.equal(raw.includes(Buffer.from(USER)), false, fp);
    assert.equal(raw.includes(Buffer.from(OWNER)), false, fp);
  }
  assert.equal(seen.length, 0);
});

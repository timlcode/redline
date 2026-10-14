import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as P from "./lib/pdf.mjs";
import * as S from "./lib/send.mjs";
import * as O from "./lib/ocrdoc.mjs";
import { pageTextKind } from "./lib/textlayer.mjs";
import * as M from "./lib/measure.mjs";
import * as Forms from "./lib/forms.mjs";
import * as Flat from "./lib/flatten.mjs";
import * as Comp from "./lib/compress.mjs";
import * as Sig from "./lib/signatures.mjs";
import { signWithCertificate } from "./lib/digitalsign.mjs";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, "public");
const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8")).version;
const MAX_UPLOAD = 1024 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export function backupPathFor(file) {
  const ext = path.extname(file);
  const base = ext.toLowerCase() === ".pdf" ? file.slice(0, -ext.length) : file;
  return `${base}.redline-bak.pdf`;
}

async function atomicWrite(file, bytes) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.redline-${process.pid}-${Date.now()}.tmp`);
  try {
    await fsp.writeFile(tmp, bytes);
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

export function createServer(opts = {}) {
  const dataDir = opts.dataDir || process.env.REDLINE_DATA_DIR || path.join(os.homedir(), ".local/share/redline");
  const workDir = path.join(dataDir, "work");
  const workFile = path.join(workDir, "current.pdf");
  const outboxDir = path.join(dataDir, "outbox");
  const sender = opts.sender || S;
  const allowedHosts = new Set(opts.allowedHosts || []);
  fs.mkdirSync(workDir, { recursive: true });

  // ---------- settings (author name for comments) ----------
  const settingsFile = path.join(dataDir, "settings.json");
  let settings = { author: "" };
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, "utf8")) }; } catch {}
  if (!settings.author) settings.author = os.userInfo().username || "";
  P.setDefaultAuthor(settings.author);
  function saveSettings(patch) {
    settings = { ...settings, ...patch };
    settings.author = String(settings.author || "").trim().slice(0, 80);
    P.setDefaultAuthor(settings.author);
    try { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch (e) { console.error("settings write failed:", e.message); }
    return settings;
  }

  const state = {
    doc: null,
    sourcePath: null,
    name: null,
    dirty: false,
    rev: 0,
    // true when the open file required a user (open) password. The password
    // itself is never stored.
    userPasswordSet: false,
  };
  let persistTimer = null;

  function persistSoon() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (!state.doc) return;
      try {
        fs.writeFileSync(workFile, P.saveBytes(state.doc));
      } catch (e) {
        console.error("work copy write failed:", e.message);
      }
    }, 1500);
    persistTimer.unref?.();
  }

  function summary(page = 0) {
    const pages = P.pageSizes(state.doc);
    const p = Math.max(0, Math.min(pages.length - 1, page));
    return {
      pageCount: pages.length,
      width: pages[p].width,
      height: pages[p].height,
      pages,
      sourcePath: state.sourcePath,
      name: state.name,
      dirty: state.dirty,
      rev: state.rev,
      page: p,
      protection: protectionState(),
      ...undoInfo(),
    };
  }

  function protectionState() {
    if (!state.doc) return { encrypted: false, method: null, print: true, copy: true, edit: true, userPassword: false };
    return { ...P.protectionInfo(state.doc), userPassword: state.userPasswordSet };
  }

  function undoInfo() {
    const doc = state.doc;
    if (!doc) return { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };
    let j = { position: 0, steps: [] };
    try { j = doc.getJournal(); } catch {}
    return {
      canUndo: doc.canUndo(),
      canRedo: doc.canRedo(),
      undoLabel: j.position > 0 ? j.steps[j.position - 1] : null,
      redoLabel: j.position < j.steps.length ? j.steps[j.position] : null,
    };
  }

  /** Run a user edit as one undoable journal step. */
  function op(name, fn) {
    const doc = needDoc();
    doc.beginOperation(name);
    let out;
    try {
      out = fn(doc);
    } catch (e) {
      try { doc.abandonOperation(); } catch {}
      throw e;
    }
    doc.endOperation();
    return out;
  }

  function undoRedo(which) {
    const doc = needDoc();
    if (which === "undo" ? !doc.canUndo() : !doc.canRedo()) throw P.httpError(400, `Nothing to ${which}`);
    const label = which === "undo" ? undoInfo().undoLabel : undoInfo().redoLabel;
    if (which === "undo") doc.undo(); else doc.redo();
    ocrPagesChanged();
    mutated();
    return { ...summary(0), did: which, label };
  }

  function mutated() {
    state.dirty = true;
    state.rev++;
    persistSoon();
  }

  function loadDoc(bytes, sourcePath, name, password) {
    if (!P.isPdfBytes(bytes)) {
      // an image opens as a one-page document (unsaved: Save As decides where it goes)
      if (!P.isImageBytes(new Uint8Array(bytes))) throw P.httpError(400, "Not a PDF file");
      bytes = P.saveBytes(P.openSource(new Uint8Array(bytes)));
      sourcePath = null;
      name = String(name || "image").replace(/\.[^.]+$/, "") + ".pdf";
      password = undefined;
    }
    // Copy off any WASM view, then open once. A rejected password must not
    // replace the working copy or the document already open.
    const copy = Buffer.from(bytes);
    const opened = P.openPdf(new Uint8Array(copy), password);
    const doc = opened.doc;
    if (doc.countPages() < 1) {
      try { doc.destroy(); } catch { /* already gone */ }
      throw P.httpError(400, "PDF has no pages");
    }
    fs.writeFileSync(workFile, copy);
    doc.enableJournal();
    state.doc = doc;
    state.sourcePath = sourcePath;
    state.name = name;
    state.dirty = false;
    state.userPasswordSet = opened.passwordRequired;
    state.rev++;
    try { ocrOnOpen(); } catch (e) { console.error("ocr on open:", e.message); }
    return summary(0);
  }

  function resolveUser(p) {
    if (typeof p !== "string" || !p) throw P.httpError(400, "path required");
    return path.resolve(p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
  }

  /** Adopt a document built in memory (combine) as the open document; it has no file yet. */
  function adoptDoc(doc, name) {
    const bytes = P.saveBytes(doc);
    return loadDoc(bytes, null, name);
  }

  async function readSource(p) {
    const abs = resolveUser(p);
    let st;
    try { st = await fsp.stat(abs); } catch { throw P.httpError(404, `No such file: ${abs}`); }
    if (!st.isFile()) throw P.httpError(400, `Not a file: ${abs}`);
    const bytes = new Uint8Array(await fsp.readFile(abs));
    try {
      return { doc: P.openSource(bytes), name: path.basename(abs) };
    } catch (e) {
      throw P.httpError(e.status || 400, `${path.basename(abs)}: ${e.message}`);
    }
  }

  async function openPath(p, password) {
    if (typeof p !== "string" || !p) throw P.httpError(400, "path required");
    const abs = path.resolve(p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      throw P.httpError(404, `No such file: ${abs}`);
    }
    if (!st.isFile()) throw P.httpError(400, "Not a regular file");
    const fh = await fsp.open(abs, "r");
    const head = Buffer.alloc(5);
    await fh.read(head, 0, 5, 0);
    await fh.close();
    const bytes = await fsp.readFile(abs);
    if (head.toString("latin1") !== "%PDF-" && !P.isImageBytes(new Uint8Array(bytes))) throw P.httpError(400, "Not a PDF or image file");
    return loadDoc(bytes, abs, path.basename(abs), password);
  }

  function dropDoc(doc) {
    if (!doc || doc === state.doc) return;
    try { doc.destroy(); } catch { /* already gone */ }
  }

  function adoptWorkingDoc(doc) {
    if (!doc || doc === state.doc) return;
    doc.enableJournal();
    const prev = state.doc;
    state.doc = doc;
    state.rev++;
    dropDoc(prev);
  }

  /**
   * Stamp placed signatures, and optionally bake forms and markup, on a copy.
   * Save adopts that copy so the open file matches what was written.
   * A download leaves the open file alone so a signature can still be moved.
   */
  function materializeOutput({ stampSignatures = false, flatten = null, replace = false } = {}) {
    let doc = state.doc;
    let stamped = 0;
    let changed = false;
    let flattened = false;
    if (stampSignatures && Sig.hasPlacedFlag(doc)) {
      const baked = Sig.documentWithStampedSignatures(doc);
      if (baked.changed && baked.doc !== doc) {
        doc = baked.doc;
        stamped = baked.count;
        changed = true;
      }
    }
    if (flatten && (flatten.forms || flatten.annotations)) {
      const base = changed ? doc : P.openBytes(new Uint8Array(P.saveBytes(doc)));
      Flat.flattenDocument(base, flatten);
      const fresh = P.openBytes(new Uint8Array(P.saveBytes(base)));
      if (base !== state.doc) dropDoc(base);
      doc = fresh;
      changed = true;
      flattened = true;
    }
    if (replace && changed) adoptWorkingDoc(doc);
    return { doc: replace && changed ? state.doc : doc, stamped, changed, flattened };
  }

  function exportBytes(spec, output = {}) {
    const prepared = materializeOutput({
      stampSignatures: output.stampSignatures !== false,
      flatten: output.flatten || null,
      replace: false,
    });
    try {
      return { bytes: P.saveBytes(prepared.doc, spec), stamped: prepared.stamped, flattened: prepared.flattened };
    } finally {
      if (prepared.changed) dropDoc(prepared.doc);
    }
  }

  // Before the first overwrite of an existing file, keep its untouched bytes as
  // <name>.redline-bak.pdf; an existing backup is never replaced.
  async function saveTo(target, protectionInput, output = {}) {
    const spec = P.normalizeProtection(protectionInput);
    const prepared = materializeOutput({
      stampSignatures: output.stampSignatures !== false,
      flatten: output.flatten || null,
      replace: true,
    });
    let bytes;
    try {
      bytes = P.saveBytes(state.doc, spec);
    } finally {
      // Drop password strings held by this request. The encrypted file does
      // not contain them, and they are not written anywhere else.
      if (spec.mode === "password") {
        spec.userPassword = "";
        spec.ownerPassword = "";
      }
    }
    if (spec.mode === "none") state.userPasswordSet = false;
    else if (spec.mode === "password") state.userPasswordSet = !!protectionInput.userPassword;
    const bak = backupPathFor(target);
    let backup = null;
    if (fs.existsSync(target) && !fs.existsSync(bak)) {
      await fsp.copyFile(target, bak, fs.constants.COPYFILE_EXCL);
      backup = bak;
    }
    await atomicWrite(target, bytes);
    fs.writeFileSync(workFile, bytes);
    state.sourcePath = target;
    state.name = path.basename(target);
    state.dirty = false;
    return {
      ok: true,
      path: target,
      bytes: bytes.length,
      dirty: false,
      backup,
      protection: protectionState(),
      stamped: prepared.stamped,
      flattened: prepared.flattened,
      rev: state.rev,
    };
  }

  function passwordFromHeader(req) {
    const h = req.headers["x-password"];
    if (h == null || h === "") return undefined;
    try { return decodeURIComponent(String(h)); } catch { return undefined; }
  }

  function runPicker(mode, pickOpts = {}) {
    if (opts.pick) return Promise.resolve(opts.pick(mode, pickOpts));
    if (opts.pickCommand === false) return Promise.reject(P.httpError(501, "Picker disabled"));
    const suggest = pickOpts.suggest;
    const cmd = opts.pickCommand || [fs.existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3", path.join(APP_DIR, "bin/pick-file.py")];
    return new Promise((resolve, reject) => {
      const args = [...cmd.slice(1), mode];
      if (mode === "save" || mode === "save-any") args.push(suggest || state.name || "marked.pdf");
      else args.push("");
      args.push(state.sourcePath ? path.dirname(state.sourcePath) : "");
      const child = spawn(cmd[0], args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => reject(P.httpError(500, `Picker failed: ${e.message}`)));
      child.on("close", (code) => {
        if (code !== 0) return reject(P.httpError(500, `Picker failed: ${err.trim().split("\n").pop() || code}`));
        const p = out.trim();
        if (mode === "files") return resolve(p ? { paths: p.split("\n").filter(Boolean) } : { canceled: true });
        resolve(p ? { path: p } : { canceled: true });
      });
    });
  }

  // Snapshot of the document as it is right now (unsaved markup included), named
  // like the open file, for attaching or transferring.
  function exportForSend() {
    const bytes = P.saveBytes(needDoc());
    // One folder per send: an open Thunderbird draft still points at its copy.
    // Snapshots older than two days are cleaned up.
    fs.mkdirSync(outboxDir, { recursive: true });
    const cutoff = Date.now() - 2 * 86400e3;
    for (const f of fs.readdirSync(outboxDir)) {
      const fp = path.join(outboxDir, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) fs.rmSync(fp, { force: true, recursive: true });
      } catch {}
    }
    let name = (state.name || "redline.pdf").replace(/[\/\x00-\x1f]/g, "_");
    if (!/\.pdf$/i.test(name)) name += ".pdf";
    const dir = fs.mkdtempSync(path.join(outboxDir, `${Date.now()}-`));
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    return file;
  }

  function needDoc() {
    if (!state.doc) throw P.httpError(404, "No document open");
    return state.doc;
  }

  // ---------- OCR ----------
  // Lazy, page-at-a-time, like Acrobat: the page being viewed is read first, a short look-ahead
  // after it, and everything else only on request. Small scanned documents (<= AUTO_OCR_PAGES
  // unread pages) are read completely in the background on open. One page is processed at a time;
  // the inference itself runs on ONNX Runtime's threads so rendering and markup stay responsive.
  const AUTO_OCR_PAGES = opts.autoOcrPages ?? Number(process.env.REDLINE_AUTO_OCR_PAGES ?? 10);
  const ocr = { queue: [], running: false, doc: null, page: -1, done: 0, error: null, lastMs: 0, kinds: [] };

  function textKinds() {
    const doc = needDoc();
    const n = doc.countPages();
    const kinds = [];
    for (let i = 0; i < n; i++) {
      try { kinds.push(pageTextKind(doc, i)); } catch { kinds.push("none"); }
    }
    ocr.kinds = kinds;
    return kinds;
  }

  function ocrReset() {
    ocr.queue = [];
    ocr.done = 0;
    ocr.error = null;
    ocr.kinds = [];
  }

  /** Queue pages for reading. front=true puts them ahead of everything else (the page on screen). */
  function ocrEnqueue(pages, { front = false, force = false } = {}) {
    const doc = needDoc();
    const n = doc.countPages();
    const kinds = ocr.kinds.length === n ? ocr.kinds : textKinds();
    const want = (Array.isArray(pages) ? pages.map(Number) : [...Array(n).keys()])
      .filter((i) => Number.isInteger(i) && i >= 0 && i < n)
      .filter((i) => force || kinds[i] === "none")
      .filter((i) => i !== ocr.page || force);
    const rest = ocr.queue.filter((q) => !want.includes(q.page));
    const items = want.map((page) => ({ page, force }));
    ocr.queue = front ? [...items, ...rest] : [...rest, ...items];
    ocr.doc = doc;
    if (!ocr.running && ocr.queue.length) ocrWorker();
    return ocrStatus();
  }

  async function ocrWorker() {
    ocr.running = true;
    ocr.error = null;
    try {
      await O.engine();
      while (ocr.queue.length) {
        const doc = state.doc;
        if (!doc || doc !== ocr.doc) { ocr.queue = []; break; }
        let { page, force } = ocr.queue.shift();
        ocr.page = page;
        try {
          // Pages can be inserted/deleted/moved while the engine runs: remember which page
          // object we read, and write the layer to wherever it is afterwards.
          const ref = doc.findPage(page).asIndirect();
          const rec = await O.recognizePage(doc, page, { force });
          if (state.doc !== doc) break;
          if (doc.countPages() <= page || doc.findPage(page).asIndirect() !== ref) {
            let found = -1;
            for (let i = 0; i < doc.countPages(); i++) if (doc.findPage(i).asIndirect() === ref) { found = i; break; }
            if (found < 0) { ocr.done++; continue; } // page is gone
            page = found;
            rec.page = found;
          }
          // The layer write is synchronous and merges into the previous user step (or into
          // nothing on a fresh document), so Undo never has an "OCR" step of its own.
          doc.beginImplicitOperation();
          let r;
          try {
            r = O.applyPage(doc, rec);
          } catch (e) {
            try { doc.abandonOperation(); } catch {}
            throw e;
          }
          doc.endOperation();
          ocr.lastMs = r.ms;
          ocr.done++;
          if (!r.skipped) {
            ocr.kinds[page] = "ocr";
            // Background reading is not an edit: no dirty flag, but the text goes out with Save/Send.
            state.rev++;
            persistSoon();
          }
        } catch (e) {
          ocr.error = `Page ${page + 1}: ${String(e.message || e)}`;
          console.error(new Date().toISOString(), "ocr:", ocr.error);
        }
      }
    } finally {
      ocr.running = false;
      ocr.page = -1;
    }
  }

  /** Page order changed: drop the queue and the cached kinds (indices moved). */
  function ocrPagesChanged() {
    ocr.queue = [];
    ocr.kinds = [];
  }

  function ocrCancel() {
    const n = ocr.queue.length;
    ocr.queue = [];
    return { ok: true, dropped: n, ...ocrStatus() };
  }

  function ocrStatus() {
    const kinds = state.doc && ocr.kinds.length === state.doc.countPages() ? ocr.kinds : state.doc ? textKinds() : [];
    const unread = kinds.filter((k) => k === "none").length;
    return {
      running: ocr.running,
      page: ocr.page,
      queued: ocr.queue.map((q) => q.page),
      done: ocr.done,
      unread,
      error: ocr.error,
      lastMs: ocr.lastMs,
      kinds,
      rev: state.rev,
      autoLimit: AUTO_OCR_PAGES,
    };
  }

  /** On open: small scanned documents are read completely; big ones wait for the viewer. */
  function ocrOnOpen() {
    ocrReset();
    const kinds = textKinds();
    const unread = kinds.map((k, i) => (k === "none" ? i : -1)).filter((i) => i >= 0);
    if (unread.length && unread.length <= AUTO_OCR_PAGES) ocrEnqueue(unread);
  }

  function searchDoc(q, only) {
    const doc = needDoc();
    const n = doc.countPages();
    const pages = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (only !== null && only !== i) continue;
      const hits = O.searchPage(doc, i, q);
      if (hits.length) pages.push({ page: i, hits });
      total += hits.length;
    }
    return { q, total, pages };
  }

  function readBody(req, limit = 4 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > limit) {
          reject(P.httpError(413, "Body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  async function readJson(req) {
    const b = await readBody(req);
    if (!b.length) return {};
    try {
      return JSON.parse(b.toString("utf8"));
    } catch {
      throw P.httpError(400, "Bad JSON");
    }
  }

  function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    res.writeHead(status, { "Content-Type": type, "Content-Length": buf.length, "Cache-Control": "no-store", ...extra });
    res.end(buf);
  }

  const json = (res, obj, status = 200) => send(res, status, obj);

  async function serveStatic(res, urlPath) {
    let rel = urlPath === "/" ? "/index.html" : urlPath;
    if (rel === "/icon.svg") return send(res, 200, await fsp.readFile(path.join(APP_DIR, "assets/redline.svg")), MIME[".svg"]);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: "Not found" });
    try {
      const data = await fsp.readFile(file);
      send(res, 200, data, MIME[path.extname(file)] || "application/octet-stream");
    } catch {
      send(res, 404, { error: "Not found" });
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname;
    const m = req.method;

    const host = (req.headers.host || "").toLowerCase();
    const hostName = host.replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost"].includes(hostName) && !allowedHosts.has(host)) {
      return json(res, { error: "Bad host" }, 403);
    }
    if (m !== "GET" && m !== "HEAD" && req.headers["x-redline"] !== "1") {
      return json(res, { error: "Missing X-Redline header" }, 403);
    }

    if (!p.startsWith("/api/")) {
      if (m !== "GET") return json(res, { error: "Not found" }, 404);
      return serveStatic(res, p);
    }

    if (p === "/api/health" && m === "GET") return json(res, { ok: true, version: VERSION });

    if (p === "/api/open" && m === "POST") {
      const body = await readJson(req);
      const password = typeof body.password === "string" ? body.password : undefined;
      try {
        return json(res, await openPath(body.path, password));
      } finally {
        body.password = undefined;
      }
    }
    if (p === "/api/open-upload" && m === "POST") {
      const bytes = await readBody(req, MAX_UPLOAD);
      const raw = req.headers["x-filename"];
      const name = raw ? path.basename(decodeURIComponent(String(raw))) : "upload.pdf";
      return json(res, loadDoc(bytes, null, name, passwordFromHeader(req)));
    }
    if (p === "/api/doc" && m === "GET") {
      needDoc();
      return json(res, summary(Number(url.searchParams.get("page")) || 0));
    }

    let mm;
    if ((mm = p.match(/^\/api\/page\/(\d+)\/tile$/)) && m === "GET") {
      const png = P.renderTile(
        needDoc(),
        Number(mm[1]),
        P.clampZoom(url.searchParams.get("zoom") ?? 1),
        url.searchParams.get("x"),
        url.searchParams.get("y"),
        url.searchParams.get("w"),
        url.searchParams.get("h"),
        state.rev,
      );
      return send(res, 200, png, "image/png");
    }
    if ((mm = p.match(/^\/api\/page\/(\d+)$/)) && m === "GET") {
      const png = P.renderPage(needDoc(), Number(mm[1]), P.clampZoom(url.searchParams.get("zoom") ?? 1));
      return send(res, 200, png, "image/png");
    }
    if ((mm = p.match(/^\/api\/thumbs\/(\d+)$/)) && m === "GET") {
      return send(res, 200, P.renderThumb(needDoc(), Number(mm[1]), 140, state.rev), "image/png");
    }
    if (p === "/api/annots" && m === "GET") {
      return json(res, P.listAnnots(needDoc(), Number(url.searchParams.get("page") ?? 0)));
    }
    if (p === "/api/annots/all" && m === "GET") return json(res, P.listAllAnnots(needDoc()));
    if (p === "/api/stamps" && m === "GET") return json(res, { stamps: settings.stamps || [], author: settings.author });
    if (p === "/api/stamps" && m === "POST") {
      const b = await readJson(req);
      const label = String(b.label || "").trim().slice(0, 100);
      if (!label) throw P.httpError(400, "Stamp text required");
      const items = settings.stamps || [];
      const item = { id: Date.now().toString(36), label, dynamic: !!b.dynamic };
      saveSettings({ stamps: [...items, item] });
      return json(res, item, 201);
    }
    if ((mm = p.match(/^\/api\/stamps\/([a-z0-9]+)$/)) && m === "DELETE") {
      const items = settings.stamps || [];
      saveSettings({ stamps: items.filter((a) => a.id !== mm[1]) });
      return json(res, { ok: true });
    }
    if (p === "/api/stamps/resolve" && m === "POST") {
      const b = await readJson(req);
      const label = String(b.label || "").trim();
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const time = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return json(res, { label: label.replace(/\{date\}/gi, date).replace(/\{time\}/gi, time).replace(/\{author\}/gi, settings.author) });
    }
    if (p === "/api/settings" && m === "GET") return json(res, settings);
    if (p === "/api/settings" && (m === "POST" || m === "PUT")) {
      const b = await readJson(req);
      return json(res, saveSettings({ author: b.author }));
    }
    if ((mm = p.match(/^\/api\/annots\/(\d+)\/reply$/)) && m === "POST") {
      const b = await readJson(req);
      if (!String(b.contents || "").trim()) throw P.httpError(400, "Reply is empty");
      const a = op("reply", (doc) => P.replyToAnnot(doc, Number(mm[1]), b.contents, settings.author));
      mutated();
      return json(res, a, 201);
    }
    if (p === "/api/annots/summary.csv" && m === "GET") {
      const name = (state.name || "redline.pdf").replace(/[^\w.\- ]/g, "_");
      return send(res, 200, P.annotsToCsv(needDoc(), state.name || ""), "text/csv; charset=utf-8", { "Content-Disposition": `attachment; filename="${name.replace(/\.pdf$/i, "")} comments.csv"` });
    }
    if (p === "/api/annots/summary.pdf" && m === "GET") {
      const name = (state.name || "redline.pdf").replace(/[^\w.\- ]/g, "_");
      return send(res, 200, P.saveBytes(P.annotsSummaryPdf(needDoc(), state.name || "")), "application/pdf", { "Content-Disposition": `attachment; filename="${name.replace(/\.pdf$/i, "")} comments.pdf"` });
    }
    if (p === "/api/annots/export" && m === "POST") {
      // {format:"csv"|"pdf", path}
      const b = await readJson(req);
      const doc = needDoc();
      const fmt = b.format === "pdf" ? "pdf" : "csv";
      let target = resolveUser(b.path);
      if (!target.toLowerCase().endsWith("." + fmt)) target += "." + fmt;
      if (!fs.existsSync(path.dirname(target))) throw P.httpError(400, "Folder does not exist");
      const bytes = fmt === "pdf" ? P.saveBytes(P.annotsSummaryPdf(doc, state.name || "")) : Buffer.from(P.annotsToCsv(doc, state.name || ""), "utf8");
      await atomicWrite(target, bytes);
      return json(res, { ok: true, path: target, bytes: bytes.length });
    }
    if (p === "/api/annots/image-stamp" && m === "POST") {
      const bytes = new Uint8Array(await readBody(req, 20 * 1024 * 1024));
      if (!P.isImageBytes(bytes)) throw P.httpError(400, "Stamp must be an image");
      const page = Number(url.searchParams.get("page"));
      const zoom = Number(url.searchParams.get("zoom")) || 1;
      const rect = (url.searchParams.get("rect") || "").split(",").map(Number);
      if (rect.length !== 4 || rect.some((v) => !Number.isFinite(v))) throw P.httpError(400, "rect required");
      const label = url.searchParams.get("label") || "Image stamp";
      const a = op("add image stamp", (doc) => P.createAnnot(doc, { page, zoom, tool: "image-stamp", rect, label, imageBytes: bytes, author: settings.author }));
      mutated();
      return json(res, a, 201);
    }
    if (p === "/api/annots" && m === "POST") {
      const body = await readJson(req);
      body.author = settings.author;
      const a = op(`add ${body.tool || "markup"}`, (doc) => P.createAnnot(doc, body));
      mutated();
      return json(res, a, 201);
    }
    if ((mm = p.match(/^\/api\/annots\/(\d+)$/))) {
      const id = Number(mm[1]);
      if (m === "PATCH") {
        const body = await readJson(req);
        const a = op(body.dx || body.dy ? "move markup" : "edit markup", (doc) => P.patchAnnot(doc, id, body));
        mutated();
        return json(res, a);
      }
      if (m === "DELETE") {
        const r = op("delete markup", (doc) => P.deleteAnnot(doc, id));
        mutated();
        return json(res, { ok: true, ...r });
      }
    }
    if (p === "/api/pages/rotate" && m === "POST") {
      const b = await readJson(req);
      const rotate = op("rotate page", (doc) => P.rotatePage(doc, Number(b.page), Number(b.delta)));
      mutated();
      return json(res, { ...summary(Number(b.page)), rotate });
    }
    if (p === "/api/pages/delete" && m === "POST") {
      const b = await readJson(req);
      op("delete page", (doc) => P.deletePage(doc, Number(b.page)));
      ocrPagesChanged();
      mutated();
      return json(res, summary(Math.min(Number(b.page), state.doc.countPages() - 1)));
    }
    if (p === "/api/pages/move" && m === "POST") {
      const b = await readJson(req);
      op("move page", (doc) => P.movePage(doc, Number(b.from), Number(b.to)));
      ocrPagesChanged();
      mutated();
      return json(res, summary(Number(b.to)));
    }
    if (p === "/api/pages/insert" && m === "POST") {
      const b = await readJson(req);
      const at = Number(b.at);
      const like = b.like === undefined ? undefined : Number(b.like);
      const pos = op("insert page", (doc) => P.insertBlankPage(doc, at, like));
      ocrPagesChanged();
      mutated();
      return json(res, summary(pos));
    }
    if (p === "/api/pages/insert-file" && m === "POST") {
      // {paths:[...] | path, at?, pages?} — PDFs or images, in order, inserted at `at` (default end)
      const b = await readJson(req);
      const paths = Array.isArray(b.paths) ? b.paths : b.path ? [b.path] : [];
      if (!paths.length) throw P.httpError(400, "paths required");
      needDoc();
      const sources = [];
      for (const sp of paths) sources.push(await readSource(sp));
      let at = Number.isInteger(b.at) ? b.at : state.doc.countPages();
      let inserted = 0;
      op(`insert ${paths.length === 1 ? sources[0].name : paths.length + " files"}`, (doc) => {
        for (const { doc: src } of sources) {
          const pages = b.pages !== undefined && sources.length === 1 ? P.parsePageRange(b.pages, src.countPages()) : undefined;
          const n = P.insertPagesFrom(doc, src, at, pages);
          at += n;
          inserted += n;
        }
      });
      ocrPagesChanged();
      mutated();
      return json(res, { ...summary(Math.max(0, at - inserted)), inserted });
    }
    if (p === "/api/pages/insert-upload" && m === "POST") {
      const bytes = new Uint8Array(await readBody(req, MAX_UPLOAD));
      const raw = req.headers["x-filename"];
      const name = raw ? path.basename(decodeURIComponent(String(raw))) : "file";
      needDoc();
      let src;
      try { src = P.openSource(bytes); } catch (e) { throw P.httpError(400, `${name}: ${e.message}`); }
      const atQ = url.searchParams.get("at");
      const at = atQ !== null && atQ !== "" ? Number(atQ) : state.doc.countPages();
      const inserted = op(`insert ${name}`, (doc) => P.insertPagesFrom(doc, src, at));
      ocrPagesChanged();
      mutated();
      return json(res, { ...summary(at), inserted });
    }
    if (p === "/api/combine" && m === "POST") {
      // {paths:[...]} -> a new, unsaved document made of all of them in order
      const b = await readJson(req);
      if (!Array.isArray(b.paths) || !b.paths.length) throw P.httpError(400, "paths required");
      const sources = [];
      for (const sp of b.paths) sources.push(await readSource(sp));
      const out = sources[0].doc;
      for (const { doc: src } of sources.slice(1)) P.insertPagesFrom(out, src, out.countPages());
      const base = sources[0].name.replace(/\.[^.]+$/, "");
      return json(res, { ...adoptDoc(out, `${base} combined.pdf`), combined: sources.length });
    }
    if (p === "/api/pages/extract" && m === "POST") {
      // {pages:"1-3,5", path, remove?} -> writes a new PDF; remove=true also deletes them here
      const b = await readJson(req);
      const doc = needDoc();
      const pages = P.parsePageRange(b.pages, doc.countPages());
      if (!pages.length) throw P.httpError(400, "No pages selected");
      let target = resolveUser(b.path);
      if (!/\.pdf$/i.test(target)) target += ".pdf";
      if (!fs.existsSync(path.dirname(target))) throw P.httpError(400, "Folder does not exist");
      const out = P.extractPages(doc, pages);
      await atomicWrite(target, P.saveBytes(out));
      let removed = 0;
      if (b.remove) {
        removed = op(`extract ${pages.length} page${pages.length === 1 ? "" : "s"}`, (d) => P.deletePages(d, pages));
        ocrPagesChanged();
        mutated();
      }
      return json(res, { ...summary(Math.min(Number(b.current) || 0, doc.countPages() - 1)), ok: true, path: target, pages: pages.length, removed });
    }
    if (p === "/api/pages/delete-many" && m === "POST") {
      const b = await readJson(req);
      const doc = needDoc();
      const pages = P.parsePageRange(b.pages, doc.countPages());
      const removed = op(`delete ${pages.length} page${pages.length === 1 ? "" : "s"}`, (d) => P.deletePages(d, pages));
      ocrPagesChanged();
      mutated();
      return json(res, { ...summary(Math.min(pages[0], doc.countPages() - 1)), removed });
    }
    if (p === "/api/pages/split" && m === "POST") {
      // {mode:"every"|"ranges"|"each", every?, ranges?, dir, base?} -> files <base>-<n>.pdf in dir
      const b = await readJson(req);
      const doc = needDoc();
      const dir = resolveUser(b.dir);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw P.httpError(400, "Folder does not exist");
      const plan = P.splitPlan(doc, b);
      const base = String(b.base || (state.name || "document").replace(/\.pdf$/i, "")).replace(/[\/\x00-\x1f]/g, "_");
      const files = [];
      for (let k = 0; k < plan.length; k++) {
        const pages = plan[k];
        const label = pages.length === 1 ? `p${pages[0] + 1}` : `p${pages[0] + 1}-${pages[pages.length - 1] + 1}`;
        const file = path.join(dir, `${base}-${label}.pdf`);
        await atomicWrite(file, P.saveBytes(P.extractPages(doc, pages)));
        files.push({ path: file, pages: pages.length });
      }
      return json(res, { ok: true, files });
    }
    if (p === "/api/save" && m === "POST") {
      needDoc();
      const b = await readJson(req);
      if (!state.sourcePath) return json(res, { error: "No source path; use Save As" }, 400);
      try {
        return json(res, await saveTo(state.sourcePath, b.protection, b));
      } finally {
        if (b.protection) {
          b.protection.userPassword = undefined;
          b.protection.ownerPassword = undefined;
        }
      }
    }
    if (p === "/api/save-as" && m === "POST") {
      needDoc();
      const b = await readJson(req);
      if (typeof b.path !== "string" || !b.path) throw P.httpError(400, "path required");
      let target = path.resolve(b.path.startsWith("~/") ? path.join(os.homedir(), b.path.slice(2)) : b.path);
      if (!/\.pdf$/i.test(target)) target += ".pdf";
      if (!fs.existsSync(path.dirname(target))) throw P.httpError(400, "Folder does not exist");
      try {
        return json(res, await saveTo(target, b.protection, b));
      } finally {
        if (b.protection) {
          b.protection.userPassword = undefined;
          b.protection.ownerPassword = undefined;
        }
      }
    }
    if (p === "/api/download" && m === "POST") {
      needDoc();
      const b = await readJson(req);
      const hadUserPassword = !!(b.protection && b.protection.userPassword);
      const spec = P.normalizeProtection(b.protection);
      let exported;
      try {
        exported = exportBytes(spec, b);
      } finally {
        if (spec.mode === "password") {
          spec.userPassword = "";
          spec.ownerPassword = "";
        }
        if (b.protection) {
          b.protection.userPassword = undefined;
          b.protection.ownerPassword = undefined;
        }
      }
      if (spec.mode === "none") state.userPasswordSet = false;
      else if (spec.mode === "password") state.userPasswordSet = hadUserPassword;
      const name = (state.name || "redline.pdf").replace(/[^\w.\- ]/g, "_");
      return send(res, 200, exported.bytes, "application/pdf", { "Content-Disposition": `attachment; filename="${name}"` });
    }
    if (p === "/api/download" && m === "GET") {
      const bytes = P.saveBytes(needDoc());
      const name = (state.name || "redline.pdf").replace(/[^\w.\- ]/g, "_");
      return send(res, 200, bytes, "application/pdf", {
        "Content-Disposition": `attachment; filename="${name}"`,
      });
    }
    if (p === "/api/send/config" && m === "GET") {
      return json(res, { ...sender.sendConfig(settings), name: state.name, interfaces: sender.lanInterfaces() });
    }
    if (p === "/api/send/email-setup" && m === "POST") return json(res, sender.openMailSetup());
    if (p === "/api/send/localsend/devices" && m === "GET") {
      return json(res, { devices: await sender.discoverLocalSend() });
    }
    if (p === "/api/send" && m === "POST") {
      const b = await readJson(req);
      const file = exportForSend();
      if (b.via === "email") return json(res, await sender.sendEmail(file, { subject: b.subject, email: settings.email || "" }));
      if (b.via === "handoff") return json(res, await sender.sendHandoff(file, settings.handoff || {}));
      if (b.via === "localsend") return json(res, await sender.sendLocalSend(file, b.device));
      throw P.httpError(400, "via must be email, handoff or localsend");
    }
    if (p === "/api/pick" && m === "POST") {
      const b = await readJson(req);
      const mode = ["save", "save-any", "files", "folder"].includes(b.mode) ? b.mode : "open";
      return json(res, await runPicker(mode, { suggest: b.suggest }));
    }
    if (p === "/api/text-kinds" && m === "GET") return json(res, { kinds: textKinds() });
    if (p === "/api/scale" && m === "GET") {
      const page = Number(url.searchParams.get("page") ?? 0);
      return json(res, { ...M.getScale(needDoc(), page), page });
    }
    if (p === "/api/scale" && m === "POST") {
      const b = await readJson(req);
      const page = Number(b.page ?? 0);
      const ptPerUnit = Number(b.ptPerUnit);
      if (!Number.isFinite(ptPerUnit) || ptPerUnit <= 0) throw P.httpError(400, "bad scale");
      const scale = op("set scale", (doc) => M.setScale(doc, page, ptPerUnit, b.unit || "in"));
      mutated();
      return json(res, { ...scale, page });
    }
    if (p === "/api/scale/reset" && m === "POST") {
      const b = await readJson(req);
      const page = Number(b.page ?? 0);
      op("reset scale", (doc) => M.clearScale(doc, page));
      mutated();
      return json(res, { ...M.getScale(needDoc(), page), page });
    }
    if (p === "/api/undo" && m === "POST") return json(res, undoRedo("undo"));
    if (p === "/api/redo" && m === "POST") return json(res, undoRedo("redo"));
    if (p === "/api/textmap" && m === "GET") return json(res, P.textMap(needDoc(), Number(url.searchParams.get("page") ?? 0)));
    if (p === "/api/ocr" && m === "POST") {
      // {pages:"all"|[..], front?, force?}  "all" = read every unread page (the Read all action)
      const b = await readJson(req);
      const pages = b.pages === "all" || b.pages === undefined ? null : b.pages;
      return json(res, ocrEnqueue(pages, { front: !!b.front, force: !!b.force }), 202);
    }
    if (p === "/api/ocr" && m === "GET") return json(res, ocrStatus());
    if (p === "/api/ocr/cancel" && m === "POST") return json(res, ocrCancel());
    if (p === "/api/search" && m === "GET") {
      const q = url.searchParams.get("q") || "";
      const only = url.searchParams.has("page") ? Number(url.searchParams.get("page")) : null;
      return json(res, searchDoc(q, only));
    }
    if (p === "/api/text" && m === "GET") {
      const page = Number(url.searchParams.get("page") ?? 0);
      return send(res, 200, O.pageText(needDoc(), page), "text/plain; charset=utf-8");
    }
    if (p === "/api/fields" && m === "GET") {
      return json(res, { fields: Forms.publicFields(Forms.listFields(needDoc())) });
    }
    const fieldSig = p.match(/^\/api\/fields\/(\d+)\/signature$/);
    if (fieldSig && m === "POST") {
      const id = Number(fieldSig[1]);
      const ct = String(req.headers["content-type"] || "");
      let png;
      if (ct.includes("image/png")) png = await readBody(req, 4 * 1024 * 1024);
      else {
        const b = await readJson(req);
        if (b.id) png = Sig.readSignature(dataDir, b.id);
        else if (b.png) png = Buffer.from(String(b.png), "base64");
      }
      const field = op("sign field", (doc) => Forms.applySignatureAppearance(doc, id, png));
      mutated();
      return json(res, { field, fields: Forms.publicFields(Forms.listFields(needDoc())) });
    }
    const fieldCert = p.match(/^\/api\/fields\/(\d+)\/sign-certificate$/);
    if (fieldCert && m === "POST") {
      const found = Forms.findField(needDoc(), Number(fieldCert[1]));
      return json(res, { ok: true, result: signWithCertificate(found) });
    }
    const fieldOne = p.match(/^\/api\/fields\/(\d+)$/);
    if (fieldOne && m === "POST") {
      const b = await readJson(req);
      const id = Number(fieldOne[1]);
      const field = op("fill field", (doc) => Forms.setFieldValue(doc, id, b.value));
      mutated();
      return json(res, { field, fields: Forms.publicFields(Forms.listFields(needDoc())) });
    }
    if (p === "/api/signatures" && m === "GET") {
      return json(res, { items: Sig.listSignatures(dataDir) });
    }
    if (p === "/api/signatures" && m === "POST") {
      const png = await readBody(req, 4 * 1024 * 1024);
      const kind = String(req.headers["x-sign-kind"] || "signature");
      const mode = String(req.headers["x-sign-mode"] || "draw");
      const item = Sig.saveSignature(dataDir, png, { kind, mode });
      return json(res, item, 201);
    }
    if (p === "/api/signatures/typed" && m === "POST") {
      const b = await readJson(req);
      const kind = b.kind === "initials" ? "initials" : "signature";
      const png = Sig.renderTypedSignature(b.text, { kind });
      const item = b.save === false ? null : Sig.saveSignature(dataDir, png, { kind, mode: "type" });
      return json(res, { item, png: png.toString("base64") }, 201);
    }
    if (p === "/api/signatures/place" && m === "POST") {
      const b = await readJson(req);
      let png;
      let kind = b.kind;
      if (b.id) {
        png = Sig.readSignature(dataDir, b.id);
        const stored = Sig.listSignatures(dataDir).find((it) => it.id === b.id);
        kind = kind || stored?.kind || "signature";
      } else if (b.png) {
        png = Buffer.from(String(b.png), "base64");
        kind = kind || "signature";
      } else throw P.httpError(400, "Signature image required");
      const annot = op("place signature", (doc) => Sig.placeSignature(doc, {
        page: Number(b.page) || 0,
        zoom: b.zoom,
        rect: b.rect,
        png,
        kind,
        author: settings.author,
      }));
      mutated();
      return json(res, annot);
    }
    const sigPng = p.match(/^\/api\/signatures\/([a-f0-9]{16})\.png$/);
    if (sigPng && (m === "GET" || m === "HEAD")) {
      const buf = Sig.readSignature(dataDir, sigPng[1]);
      return send(res, 200, m === "HEAD" ? Buffer.alloc(0) : buf, "image/png");
    }
    const sigDel = p.match(/^\/api\/signatures\/([a-f0-9]{16})$/);
    if (sigDel && m === "DELETE") return json(res, Sig.deleteSignature(dataDir, sigDel[1]));
    if (p === "/api/flatten" && m === "POST") {
      const b = await readJson(req);
      needDoc();
      const flatten = { annotations: b.annotations !== false, forms: b.forms !== false };
      if (!flatten.annotations && !flatten.forms) throw P.httpError(400, "Choose forms, markup, or both");
      const prepared = materializeOutput({ stampSignatures: true, flatten, replace: true });
      mutated();
      const page = Number.isInteger(b.page) ? b.page : 0;
      return json(res, { ...summary(page), flattened: prepared.flattened, stamped: prepared.stamped });
    }
    if (p === "/api/compress" && m === "POST") {
      const b = await readJson(req);
      needDoc();
      const opts = Comp.normalizeCompress(b);
      if (b.preview) {
        const copy = P.openBytes(new Uint8Array(P.saveBytes(state.doc)));
        try {
          return json(res, Comp.compressDocument(copy, opts));
        } finally {
          dropDoc(copy);
        }
      }
      const copy = P.openBytes(new Uint8Array(P.saveBytes(state.doc)));
      const result = Comp.compressDocument(copy, opts);
      if (result.imagesChanged) {
        const fresh = P.openBytes(new Uint8Array(P.saveBytes(copy)));
        dropDoc(copy);
        adoptWorkingDoc(fresh);
        mutated();
      } else {
        dropDoc(copy);
      }
      return json(res, { ...result, rev: state.rev, dirty: state.dirty });
    }
    if (p === "/api/print" && m === "POST") {
      const b = await readJson(req);
      const doc = needDoc();
      const pages = P.parsePageRange(b.pages, doc.countPages());
      if (!pages.length) throw P.httpError(400, "No pages selected");
      const prepared = materializeOutput({ stampSignatures: true, flatten: null, replace: false });
      const extracted = P.extractPages(prepared.doc, pages);
      Flat.flattenDocument(extracted, { annotations: true, forms: true });
      const bytes = P.saveBytes(extracted);
      if (prepared.changed) dropDoc(prepared.doc);
      dropDoc(extracted);
      if (b.deliver === "dialog" && typeof opts.print === "function") {
        const tmp = path.join(os.tmpdir(), `redline-print-${process.pid}-${Date.now()}.pdf`);
        await fsp.writeFile(tmp, bytes);
        try {
          await opts.print(tmp);
        } finally {
          await fsp.rm(tmp, { force: true });
        }
        return json(res, { ok: true, printed: true, pages: pages.length });
      }
      return send(res, 200, bytes, "application/pdf", {
        "Content-Disposition": 'inline; filename="print.pdf"',
      });
    }
    return json(res, { error: "Not found" }, 404);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = e.status || 500;
      if (status === 500) console.error(new Date().toISOString(), req.method, req.url, e.message);
      if (!res.headersSent) {
        const body = { error: String(e.message || e).slice(0, 300) };
        if (e.code) body.code = e.code;
        json(res, body, status);
      }
      else res.end();
    });
  });
  server.requestTimeout = 0;
  // Idle keep-alive sockets must outlive any event-loop stall (OCR post-processing), or the
  // next request on a reused socket dies with ECONNRESET.
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
  server.redline = state;
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.REDLINE_PORT || 4521);
  const server = createServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`${new Date().toISOString()} Redline ${VERSION} listening on http://127.0.0.1:${port}`);
  });
}

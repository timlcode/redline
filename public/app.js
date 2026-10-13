// Redline UI. All geometry sent to the server is in CSS pixels of the page image at
// the current zoom; the server converts it with the same matrix it renders with.

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const COLORS = { yellow: "#ffd900", red: "#e10600", green: "#1a9e33", blue: "#1a59f2" };
const DEFAULT_COLOR = { highlight: "yellow", underline: "red", strikeout: "red", note: "yellow", pen: "red", line: "red", arrow: "red", box: "red", cloud: "red", polygon: "red", polyline: "red", callout: "red", stamp: "red", measure: "red" };

const st = {
  doc: null,
  page: 0,
  zoom: 1,
  tool: "select",
  stamp: "APPROVED",
  customStamp: null,
  cloudPoly: false,
  vertices: [],
  calloutTip: null,
  scale: { ptPerUnit: 1, unit: "in" },
  measure: { mode: "distance", points: [], live: null },
  colors: { ...DEFAULT_COLOR },
  annots: [],
  selected: null,
  rev: 0,
  thumbRev: {},
  drag: null,
  pop: null,
  busy: false,
  kinds: [],
  find: null, // { q, total, pages:[{page, hits:[[quad...]]}], pi, hi }
  ocrRunning: false,
  ocrQueued: 0,
  ocrUnread: 0,
  tmap: null, // text map of the current page: { page, lines, chars:[{c,q,line}] }
  sel: null, // text selection: { a, b } global char indices (inclusive)
};

const viewer = $("#viewer");
const tiles = $("#pagetiles");
const canvas = $("#overlay");
const ctx = canvas.getContext("2d");
const wrap = $("#pagewrap");
const pop = $("#popover");
const popText = $("#pop-text");

// ---------- helpers ----------

let statusTimer = null;
function status(msg, isErr = false) {
  const el = $("#status");
  el.textContent = msg || "";
  el.classList.toggle("err", !!isErr);
  clearTimeout(statusTimer);
  if (msg && !isErr) statusTimer = setTimeout(() => (el.textContent = ""), 4000);
}

async function api(method, path, body, raw) {
  const opts = { method, headers: {} };
  if (method !== "GET") opts.headers["X-Redline"] = "1";
  if (raw) {
    opts.body = raw.body;
    Object.assign(opts.headers, raw.headers);
  } else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : null;
  if (!res.ok) {
    const e = new Error((data && data.error) || `${res.status} ${res.statusText}`);
    e.status = res.status;
    e.code = data && data.code;
    throw e;
  }
  return data;
}

async function guarded(fn) {
  try {
    return await fn();
  } catch (e) {
    status(e.message, true);
    return undefined;
  }
}

function pageSize() {
  const p = st.doc?.pages?.[st.page];
  return p ? { w: p.width, h: p.height } : { w: 612, h: 792 };
}

function colorName(tool) {
  return st.colors[tool] || "red";
}

// ---------- document state ----------

function setDoc(summary, page) {
  st.doc = summary;
  st.page = Math.max(0, Math.min(summary.pageCount - 1, page ?? summary.page ?? 0));
  st.selected = null;
  document.body.classList.add("has-doc");
  $("#empty").hidden = true;
  wrap.hidden = false;
  $("#btn-save").disabled = false;
  $("#btn-saveas").disabled = false;
  $("#btn-protect").disabled = false;
  $("#btn-send").disabled = false;
  $("#btn-ocr").disabled = false;
  $("#btn-find").disabled = false;
  $("#btn-comments").disabled = false;
  updateChrome();
}

function setDirty(d) {
  if (!st.doc) return;
  st.doc.dirty = d;
  updateChrome();
}

function updateChrome() {
  const d = st.doc;
  $("#docname").textContent = d ? d.name || "Untitled.pdf" : "No file";
  $("#docname").title = d?.sourcePath || (d ? "Not saved to disk yet - Save downloads a copy" : "");
  $("#dirty").hidden = !d?.dirty;
  $("#pageind").textContent = d ? `${st.page + 1} / ${d.pageCount}` : "– / –";
  $("#zoomind").textContent = `${Math.round(st.zoom * 100)}%`;
  document.title = d ? `${d.dirty ? "• " : ""}${d.name || "Untitled"} – Redline` : "Redline";
  $("#btn-prev").disabled = !d || st.page === 0;
  $("#btn-next").disabled = !d || st.page >= d.pageCount - 1;
  $("#btn-up").disabled = !d || st.page === 0;
  $("#btn-down").disabled = !d || st.page >= d.pageCount - 1;
  $("#btn-delete").disabled = !d || d.pageCount <= 1;
  $("#btn-undo").disabled = !d?.canUndo;
  $("#btn-redo").disabled = !d?.canRedo;
  $("#btn-undo").title = d?.undoLabel ? `Undo ${d.undoLabel} (Ctrl+Z)` : "Undo (Ctrl+Z)";
  $("#btn-redo").title = d?.redoLabel ? `Redo ${d.redoLabel} (Ctrl+Shift+Z)` : "Redo (Ctrl+Shift+Z)";
  const chip = $("#protchip");
  const prot = d?.protection;
  if (!d || (!prot?.encrypted && !pendingProtection)) {
    chip.hidden = true;
  } else if (pendingProtection?.mode === "password") {
    chip.hidden = false;
    chip.className = "chip busy";
    chip.textContent = "Protect on save";
    chip.title = "A password will be applied the next time this file is saved";
  } else if (pendingProtection?.mode === "none") {
    chip.hidden = false;
    chip.className = "chip";
    chip.textContent = "Unlock on save";
    chip.title = "Protection will be removed the next time this file is saved";
  } else {
    chip.hidden = false;
    chip.className = "chip text";
    const bits = [];
    if (!prot.print) bits.push("no print");
    if (!prot.copy) bits.push("no copy");
    if (!prot.edit) bits.push("no edit");
    chip.textContent = prot.userPassword ? "Password" : "Restricted";
    chip.title = [prot.method, bits.join(", ")].filter(Boolean).join(" · ");
  }
  $$(".thumb").forEach((t) => t.classList.toggle("active", Number(t.dataset.page) === st.page));
  updateKindChip();
}

const KIND_LABEL = { none: "Scanned · no text", ocr: "Searchable · OCR", text: "Searchable" };
function updateKindChip() {
  const el = $("#textkind");
  if (!st.doc) { el.hidden = true; return; }
  const k = st.kinds[st.page];
  if (k === "none" && (st.ocrRunning || st.ocrQueued)) { el.hidden = false; el.className = "chip busy"; el.textContent = "Reading…"; return; }
  if (!k) { el.hidden = true; return; }
  el.hidden = false;
  el.className = `chip ${k}`;
  el.textContent = KIND_LABEL[k];
  el.title = k === "none" ? "This page is an image with no text. Run OCR to make it searchable." : k === "ocr" ? "Text read by Redline OCR" : "This page has its own text";
}

async function loadKinds() {
  if (!st.doc) return;
  await ocrPoll();
  ocrAround(st.page);
}

// ---------- rendering ----------

let imgTimer = null;
// Device-pixel tiles. Keep the grid in sync with VIEW_TILE / tilesCovering in lib/pdf.mjs.
const TILE = 512;
let tileGen = 0;

function layoutPage() {
  const { w, h } = pageSize();
  const cw = Math.round(w * st.zoom);
  const ch = Math.round(h * st.zoom);
  wrap.style.width = `${cw}px`;
  wrap.style.height = `${ch}px`;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawOverlay();
}

function tilesCovering(pageW, pageH, view) {
  const x0 = Math.max(0, view.x);
  const y0 = Math.max(0, view.y);
  const x1 = Math.min(pageW, view.x + view.w);
  const y1 = Math.min(pageH, view.y + view.h);
  const out = [];
  if (!(x1 > x0 && y1 > y0)) return out;
  const gx0 = Math.floor(x0 / TILE) * TILE;
  const gy0 = Math.floor(y0 / TILE) * TILE;
  for (let y = gy0; y < y1; y += TILE) {
    for (let x = gx0; x < x1; x += TILE) {
      const tw = Math.min(TILE, pageW - x);
      const th = Math.min(TILE, pageH - y);
      if (tw > 0 && th > 0) out.push({ x, y, w: tw, h: th });
    }
  }
  return out;
}

function paintTiles() {
  if (!st.doc) return;
  const gen = ++tileGen;
  const dpr = window.devicePixelRatio || 1;
  const z = Number(Math.min(4, Math.max(0.25, st.zoom * dpr)).toFixed(3));
  const { w, h } = pageSize();
  const pw = Math.max(1, Math.ceil(w * z));
  const ph = Math.max(1, Math.ceil(h * z));
  const vr = viewer.getBoundingClientRect();
  const wr = wrap.getBoundingClientRect();
  const left = Math.max(0, vr.left - wr.left);
  const top = Math.max(0, vr.top - wr.top);
  const right = Math.min(wr.width, Math.max(left, vr.right - wr.left));
  const bottom = Math.min(wr.height, Math.max(top, vr.bottom - wr.top));
  const view = {
    x: left * dpr - TILE,
    y: top * dpr - TILE,
    w: Math.max(0, right - left) * dpr + TILE * 2,
    h: Math.max(0, bottom - top) * dpr + TILE * 2,
  };
  const need = tilesCovering(pw, ph, view);
  const keep = new Set();
  for (const t of need) {
    const key = `${st.page}:${z}:${t.x}:${t.y}:${t.w}:${t.h}:${st.rev}`;
    keep.add(key);
    if (tiles.querySelector(`img[data-key="${key}"]`)) continue;
    const im = document.createElement("img");
    im.dataset.key = key;
    im.alt = "";
    im.draggable = false;
    im.style.left = `${t.x / dpr}px`;
    im.style.top = `${t.y / dpr}px`;
    im.style.width = `${t.w / dpr}px`;
    im.style.height = `${t.h / dpr}px`;
    im.onerror = () => { if (gen === tileGen) status("Could not render page", true); };
    im.src = `/api/page/${st.page}/tile?zoom=${z}&x=${t.x}&y=${t.y}&w=${t.w}&h=${t.h}&v=${st.rev}`;
    tiles.append(im);
  }
  for (const el of [...tiles.querySelectorAll("img")]) if (!keep.has(el.dataset.key)) el.remove();
}

function loadPageImage(immediate = true) {
  if (!st.doc) return;
  layoutPage();
  clearTimeout(imgTimer);
  if (immediate) paintTiles();
  else imgTimer = setTimeout(paintTiles, 80);
}

async function loadAnnots() {
  if (!st.doc) return;
  const page = st.page;
  const list = await guarded(() => api("GET", `/api/annots?page=${page}`));
  if (list && page === st.page) {
    st.annots = list.filter((a) => a.kind !== "reply");
    if (st.selected && !list.some((a) => a.id === st.selected)) st.selected = null;
    drawOverlay();
  }
}

let thumbObserver = null;
function thumbURL(i) {
  return `/api/thumbs/${i}?v=${st.rev}`;
}
function armThumb(im) {
  if (!im || im.getAttribute("src") || !im.dataset.src) return;
  im.src = im.dataset.src;
}
function buildThumbs() {
  const box = $("#thumbs");
  box.textContent = "";
  if (thumbObserver) thumbObserver.disconnect();
  if (!st.doc) return;
  thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      armThumb(e.target.querySelector("img"));
    }
  }, { root: box, rootMargin: "240px 0px" });
  for (let i = 0; i < st.doc.pageCount; i++) {
    const t = document.createElement("div");
    t.className = "thumb";
    t.dataset.page = i;
    const im = document.createElement("img");
    im.alt = `Page ${i + 1}`;
    im.dataset.src = thumbURL(i);
    const lab = document.createElement("span");
    lab.textContent = i + 1;
    t.append(im, lab);
    t.addEventListener("click", () => gotoPage(i));
    box.append(t);
    thumbObserver.observe(t);
  }
  armThumb($(`.thumb[data-page="${st.page}"] img`));
  updateChrome();
}

function refreshThumb(i) {
  const im = $(`.thumb[data-page="${i}"] img`);
  if (!im) return;
  im.dataset.src = thumbURL(i);
  if (im.getAttribute("src")) im.src = im.dataset.src;
}

function showPage() {
  st.vertices = [];
  st.calloutTip = null;
  st.measure.points = [];
  st.measure.live = null;
  closePopover();
  loadScale();
  st.annots = [];
  loadPageImage(true);
  loadAnnots();
  updateChrome();
  ocrAround(st.page);
  $(`.thumb[data-page="${st.page}"]`)?.scrollIntoView({ block: "nearest" });
}

function gotoPage(i) {
  if (!st.doc) return;
  const n = Math.max(0, Math.min(st.doc.pageCount - 1, i));
  if (n === st.page) return;
  st.page = n;
  st.selected = null;
  showPage();
  viewer.scrollTop = 0;
}

function setZoom(z, immediate = false) {
  const nz = Math.min(4, Math.max(0.25, Math.round(z * 100) / 100));
  if (nz === st.zoom) return;
  st.zoom = nz;
  updateChrome();
  loadPageImage(immediate);
}

function fitWidth() {
  const { w } = pageSize();
  setZoom((viewer.clientWidth - 48) / w, true);
}

// ---------- overlay drawing ----------

function drawArrowHead(x0, y0, x1, y1, size) {
  const ang = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - size * Math.cos(ang - 0.45), y1 - size * Math.sin(ang - 0.45));
  ctx.lineTo(x1 - size * Math.cos(ang + 0.45), y1 - size * Math.sin(ang + 0.45));
  ctx.closePath();
  ctx.fill();
}

function drawOverlay() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.restore();
  const z = st.zoom;

  if (st.find) {
    const pg = st.find.pages.find((p) => p.page === st.page);
    if (pg) {
      pg.hits.forEach((quads, hi) => {
        const cur = st.find.pi === st.page && st.find.hi === hi;
        ctx.save();
        ctx.fillStyle = cur ? "rgba(255, 120, 0, 0.55)" : "rgba(255, 217, 0, 0.4)";
        for (const q of quads) {
          const [ulx, uly, urx, ury, llx, lly, lrx, lry] = q.map((v) => v * z);
          ctx.beginPath();
          ctx.moveTo(ulx, uly); ctx.lineTo(urx, ury); ctx.lineTo(lrx, lry); ctx.lineTo(llx, lly);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      });
    }
  }

  if (st.vertices.length) {
    ctx.save();
    ctx.strokeStyle = COLORS[colorName(st.tool)] || COLORS.red;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = Math.max(1, 2 * z);
    ctx.beginPath();
    st.vertices.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    for (const [x, y] of st.vertices) { ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
  if (st.calloutTip) {
    ctx.save(); ctx.fillStyle = COLORS[colorName("callout")];
    ctx.beginPath(); ctx.arc(st.calloutTip[0], st.calloutTip[1], 5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  if (st.tool === "measure" && st.measure.mode === "area" && st.measure.points.length) {
    ctx.save();
    ctx.strokeStyle = COLORS.measure; ctx.fillStyle = COLORS.measure;
    ctx.lineWidth = 1.5;
    const pts = st.measure.points;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (pts.length > 2) ctx.closePath();
    ctx.stroke();
    for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
  if (st.measure.live) {
    const [x, y] = st.drag ? [st.drag.x1, st.drag.y1] : (st.measure.points.at(-1) || [0, 0]);
    ctx.save();
    ctx.font = "13px ui-sans-serif, sans-serif";
    const w = ctx.measureText(st.measure.live).width;
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(x + 8, y - 22, w + 12, 20);
    ctx.fillStyle = "#ffd900";
    ctx.fillText(st.measure.live, x + 14, y - 7);
    ctx.restore();
  }
  if (st.sel && st.tmap) {
    ctx.save();
    ctx.fillStyle = "rgba(60, 130, 255, 0.35)";
    for (const q of selQuads(true)) {
      const [ulx, uly, urx, ury, llx, lly, lrx, lry] = q.map((v) => v * z);
      ctx.beginPath();
      ctx.moveTo(ulx, uly); ctx.lineTo(urx, ury); ctx.lineTo(lrx, lry); ctx.lineTo(llx, lly);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  const sel = st.annots.find((a) => a.id === st.selected);
  if (sel) {
    let [x0, y0, x1, y1] = sel.rect.map((v) => v * z);
    if (st.drag?.kind === "move") {
      x0 += st.drag.dx;
      x1 += st.drag.dx;
      y0 += st.drag.dy;
      y1 += st.drag.dy;
    }
    ctx.save();
    ctx.strokeStyle = "#e10600";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6);
    ctx.setLineDash([]);
    ctx.fillStyle = "#e10600";
    for (const [hx, hy] of [[x0 - 3, y0 - 3], [x1 + 3, y0 - 3], [x0 - 3, y1 + 3], [x1 + 3, y1 + 3]]) {
      ctx.fillRect(hx - 3, hy - 3, 6, 6);
    }
    ctx.restore();
  }

  const d = st.drag;
  if (!d || d.kind === "move") return;
  const col = COLORS[colorName(d.tool)] || COLORS.red;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (d.tool === "pen") {
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1, 2 * z);
    ctx.beginPath();
    d.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  } else if (d.tool === "line" || d.tool === "arrow") {
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = Math.max(1, 2 * z);
    ctx.beginPath();
    ctx.moveTo(d.x0, d.y0);
    ctx.lineTo(d.x1, d.y1);
    ctx.stroke();
    if (d.tool === "arrow") drawArrowHead(d.x0, d.y0, d.x1, d.y1, Math.max(10, 12 * z));
  } else {
    const x = Math.min(d.x0, d.x1);
    const y = Math.min(d.y0, d.y1);
    const rw = Math.abs(d.x1 - d.x0);
    const rh = Math.abs(d.y1 - d.y0);
    if (d.tool === "callout" && st.calloutTip) {
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath();
      ctx.moveTo(st.calloutTip[0], st.calloutTip[1]); ctx.lineTo(x, y + rh / 2); ctx.stroke();
    }
    if (d.tool === "highlight") {
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.4;
      ctx.fillRect(x, y, rw, rh);
    } else {
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1, 2 * z);
      if (d.tool === "text") ctx.setLineDash([6, 4]);
      ctx.strokeRect(x, y, rw, rh);
    }
  }
  ctx.restore();
}

// ---------- pointer handling ----------

function localPoint(ev) {
  const r = canvas.getBoundingClientRect();
  return [ev.clientX - r.left, ev.clientY - r.top];
}

function hitTest(x, y) {
  const z = st.zoom;
  for (let i = st.annots.length - 1; i >= 0; i--) {
    const a = st.annots[i];
    const [x0, y0, x1, y1] = a.rect.map((v) => v * z);
    if (x >= x0 - 4 && x <= x1 + 4 && y >= y0 - 4 && y <= y1 + 4) return a;
  }
  return null;
}

canvas.addEventListener("pointerdown", (ev) => {
  if (!st.doc || ev.button !== 0 || st.busy) return;
  if (st.pop) {
    closePopover();
    return;
  }
  const [x, y] = localPoint(ev);
  const tool = st.tool;
  if (tool === "select") {
    const hit = hitTest(x, y);
    st.selected = hit ? hit.id : null;
    $$(".cm").forEach((c) => c.classList.toggle("active", hit && Number(c.dataset.id) === hit.id));
    clearSel();
    if (hit) {
      st.drag = { kind: "move", sx: x, sy: y, dx: 0, dy: 0, id: hit.id };
    } else if (st.tmap?.chars.length) {
      const i = charAt(x, y, true);
      if (i >= 0) st.drag = { kind: "seltext", a: i, b: i, moved: false };
    }
    if (st.drag) canvas.setPointerCapture(ev.pointerId);
    drawOverlay();
    return;
  }
  if (tool === "highlight" || tool === "underline" || tool === "strikeout") {
    // on text: select words as you drag; off text (highlight only): draw an area
    const i = st.tmap?.chars.length ? charAt(x, y, true, 10) : -1;
    if (i >= 0) {
      st.selected = null;
      clearSel();
      st.drag = { kind: "seltext", a: i, b: i, moved: false, tool };
      canvas.setPointerCapture(ev.pointerId);
      drawOverlay();
      return;
    }
    if (tool !== "highlight") return;
  }
  if (tool === "note") {
    openPopover({ mode: "note", point: [x, y], anchor: [x, y] });
    return;
  }
  if (tool === "polygon" || tool === "polyline" || (tool === "cloud" && st.cloudPoly)) {
    // All pointerdown events add a vertex; dblclick fires AFTER the two pointerdown events.
    // A finishing double-click leaves two identical vertices; finishVertices strips them.
    st.vertices.push([x, y]);
    status(`${st.vertices.length} point${st.vertices.length === 1 ? "" : "s"} · double-click to finish · Esc to cancel`);
    drawOverlay();
    return;
  }
  if (tool === "callout" && !st.calloutTip) {
    st.calloutTip = [x, y];
    status("Drag a text box for the callout");
    drawOverlay();
    return;
  }
  if (tool === "measure") {
    if (st.measure.mode === "distance" || st.measure.mode === "calibrate") {
      st.selected = null;
      st.drag = { kind: "draw", tool, x0: x, y0: y, x1: x, y1: y };
      canvas.setPointerCapture(ev.pointerId);
      drawOverlay();
      return;
    }
    // area: click to add vertices, double-click finishes
    st.measure.points.push([x, y]);
    status(`${st.measure.points.length} point${st.measure.points.length === 1 ? "" : "s"} · double-click to finish area · Esc to cancel`);
    drawOverlay();
    return;
  }
  if (tool === "stamp") {
    if (stampState.imageFile) {
      st.selected = null;
      st.drag = { kind: "draw", tool: "image-stamp", x0: x, y0: y, x1: x, y1: y };
      canvas.setPointerCapture(ev.pointerId);
      drawOverlay();
      return;
    }
    if (st.customStamp) {
      const label = resolveStamp(st.customStamp.label);
      const w = Math.max(140, Math.min(360, label.length * 10 + 24)) * st.zoom;
      const h = 50 * st.zoom;
      commit({ tool: "custom-stamp", label, rect: [x - w / 2, y - h / 2, x + w / 2, y + h / 2] });
    } else commit({ tool: "stamp", stamp: st.stamp, point: [x, y] });
    return;
  }
  st.selected = null;
  st.drag = { kind: "draw", tool, x0: x, y0: y, x1: x, y1: y, points: [[x, y]] };
  canvas.setPointerCapture(ev.pointerId);
  drawOverlay();
});

canvas.addEventListener("pointermove", (ev) => {
  const [x, y] = localPoint(ev);
  const d = st.drag;
  if (!d) {
    if (st.tool === "select") canvas.classList.toggle("over-annot", !!hitTest(x, y));
    const textTool = st.tool === "select" || st.tool === "highlight" || st.tool === "underline" || st.tool === "strikeout";
    canvas.classList.toggle("over-text", textTool && !!st.tmap?.chars.length && charAt(x, y, true, 6) >= 0 && !(st.tool === "select" && hitTest(x, y)));
    return;
  }
  if (d.kind === "move") {
    d.dx = x - d.sx;
    d.dy = y - d.sy;
  } else if (d.kind === "seltext") {
    const i = charAt(x, y, true);
    if (i >= 0 && i !== d.b) { d.b = i; d.moved = true; st.sel = { a: d.a, b: d.b }; }
  } else if (d.tool === "measure") {
    d.x1 = x; d.y1 = y;
    if (st.measure.mode !== "area") {
      const pts = Math.hypot(d.x1 - d.x0, d.y1 - d.y0) / st.zoom;
      st.measure.live = fmt(pts);
      status(st.measure.live);
    }
  } else if (d.tool === "pen") {
    const evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
    for (const e of evs) {
      const p = localPoint(e);
      const last = d.points[d.points.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 1.5) d.points.push(p);
    }
  } else {
    d.x1 = x;
    d.y1 = y;
  }
  drawOverlay();
});

function endDrag(ev) {
  const d = st.drag;
  if (!d) return;
  st.drag = null;
  try {
    canvas.releasePointerCapture(ev.pointerId);
  } catch {
    /* already released */
  }
  if (d.kind === "move") {
    drawOverlay();
    if (Math.hypot(d.dx, d.dy) >= 2) moveAnnot(d.id, d.dx, d.dy);
    return;
  }
  if (d.kind === "seltext") {
    if (!d.moved) { st.sel = null; drawOverlay(); return; }
    st.sel = { a: Math.min(d.a, d.b), b: Math.max(d.a, d.b) };
    if (d.tool) {
      // markup tool: commit straight away, snapped to whole words
      snapSelToWords();
      const quads = selQuads();
      const contents = selText().slice(0, 500);
      st.sel = null;
      drawOverlay();
      if (quads.length) commit({ tool: d.tool, quads: quads.map((q) => q.map((v) => v * st.zoom)), contents });
      return;
    }
    drawOverlay();
    placeSelTools();
    return;
  }
  const rect = [Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.max(d.x0, d.x1), Math.max(d.y0, d.y1)];
  const rw = rect[2] - rect[0];
  const rh = rect[3] - rect[1];
  if (d.tool === "image-stamp") {
    const r = rw < 15 || rh < 15 ? [d.x0, d.y0, d.x0 + 160 * st.zoom, d.y0 + 100 * st.zoom] : rect;
    return commitImageStamp(r);
  }
  if (d.tool === "pen") {
    let len = 0;
    for (let i = 1; i < d.points.length; i++) {
      len += Math.hypot(d.points[i][0] - d.points[i - 1][0], d.points[i][1] - d.points[i - 1][1]);
    }
    if (d.points.length < 2 || len < 4) return drawOverlay();
    return commit({ tool: "pen", points: d.points });
  }
  if (d.tool === "measure") {
    const { mode } = st.measure;
    st.measure.live = null;
    if (mode === "distance") {
      if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) < 4) return drawOverlay();
      const pts = Math.hypot(d.x1 - d.x0, d.y1 - d.y0) / st.zoom;
      const label = fmt(pts);
      return commit({ tool: "measure-distance", from: [d.x0, d.y0], to: [d.x1, d.y1], contents: label });
    }
    if (mode === "calibrate") {
      const px = Math.hypot(d.x1 - d.x0, d.y1 - d.y0);
      const pts = px / st.zoom;
      const real = prompt("This distance on the drawing is how long, in real life? (e.g. 20 ft, 4 in, 100 cm)", "");
      if (real) {
        const m = parseReal(real);
        if (m) setScaleFrom(pts, m.value, m.unit);
      }
      return drawOverlay();
    }
    return;
  }
  if (d.tool === "line" || d.tool === "arrow") {
    if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) < 4) return drawOverlay();
    return commit({ tool: d.tool, from: [d.x0, d.y0], to: [d.x1, d.y1] });
  }
  if (d.tool === "text" || d.tool === "callout") {
    const r = rw < 12 || rh < 12 ? [d.x0, d.y0, d.x0 + 200 * st.zoom, d.y0 + 40 * st.zoom] : rect;
    st.drag = null;
    const tip = st.calloutTip;
    st.calloutTip = null;
    openPopover({ mode: d.tool, rect: r, point: tip, anchor: [r[0], r[3] + 6] });
    drawPendingRect(r);
    return;
  }
  if (rw < 3 || rh < 3) return drawOverlay();
  commit({ tool: d.tool, rect });
}

function drawPendingRect(r) {
  drawOverlay();
  ctx.save();
  ctx.strokeStyle = COLORS[colorName("text")];
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
  ctx.restore();
}

canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", (ev) => {
  st.drag = null;
  drawOverlay();
  void ev;
});

canvas.addEventListener("dblclick", (ev) => {
  if (st.tool === "measure" && st.measure.mode === "area") {
    ev.preventDefault();
    finishArea();
    return;
  }
  if (st.tool === "polygon" || st.tool === "polyline" || (st.tool === "cloud" && st.cloudPoly)) {
    ev.preventDefault();
    finishVertices();
    return;
  }
  if (st.tool !== "select") return;
  const [x, y] = localPoint(ev);
  const hit = hitTest(x, y);
  if (!hit && st.tmap?.chars.length) {
    const i = charAt(x, y, true, 6);
    if (i >= 0) {
      st.sel = { a: i, b: i };
      if (ev.detail >= 3) selectLine(i); else snapSelToWords();
      drawOverlay();
      placeSelTools();
    }
    return;
  }
  if (hit && (hit.kind === "text" || hit.kind === "note")) {
    st.selected = hit.id;
    drawOverlay();
    openPopover({ mode: "edit", id: hit.id, anchor: [hit.rect[0] * st.zoom, hit.rect[3] * st.zoom + 6], text: hit.contents });
  }
});

// ---------- mutations ----------

async function afterAnnotChange() {
  st.rev++;
  setDirty(true);
  loadPageImage(true);
  await loadAnnots();
  refreshThumb(st.page);
  refreshDocMeta();
  refreshComments();
}

async function refreshDocMeta() {
  if (!st.doc) return;
  try {
    const s = await api("GET", `/api/doc?page=${st.page}`);
    Object.assign(st.doc, s);
    updateChrome();
  } catch {}
}

async function undoRedo(which) {
  if (!st.doc) return;
  const s = await guarded(() => api("POST", `/api/${which}`));
  if (!s) return;
  st.rev++;
  cm.items = null;
  st.selected = null;
  clearSel();
  setDoc(s, Math.min(st.page, s.pageCount - 1));
  buildThumbs();
  showPage();
  setDirty(true);
  status(`${which === "undo" ? "Undid" : "Redid"} ${s.label || ""}`);
}
$("#btn-undo").addEventListener("click", () => undoRedo("undo"));
$("#btn-redo").addEventListener("click", () => undoRedo("redo"));

async function commit(spec) {
  if (!st.doc) return;
  const body = { page: st.page, zoom: st.zoom, color: colorName(spec.tool), ...spec };
  st.busy = true;
  drawOverlay();
  try {
    const a = await api("POST", "/api/annots", body);
    await afterAnnotChange();
    status(`Added ${a.stamp ? a.stamp + " stamp" : a.kind}`);
  } catch (e) {
    status(e.message, true);
    drawOverlay();
  } finally {
    st.busy = false;
  }
}

async function moveAnnot(id, dx, dy) {
  await guarded(async () => {
    await api("PATCH", `/api/annots/${id}`, { dx, dy, zoom: st.zoom });
    await afterAnnotChange();
  });
}

async function deleteSelected() {
  const id = st.selected;
  if (!id) return;
  await guarded(async () => {
    await api("DELETE", `/api/annots/${id}`);
    st.selected = null;
    await afterAnnotChange();
    status("Deleted markup");
  });
}

async function pageOp(path, body, label) {
  if (!st.doc) return;
  const s = await guarded(() => api("POST", path, body));
  if (!s) return;
  st.rev++;
  setDoc(s, s.page);
  buildThumbs();
  showPage();
  setDirty(true);
  status(label);
}

// ---------- popover (note / text / edit) ----------

function openPopover(p) {
  st.pop = p;
  popText.value = p.text || "";
  $("#pop-ok").textContent = p.mode === "edit" ? "Update" : "Add";
  popText.placeholder = p.mode === "note" ? "Note text" : p.mode === "callout" ? "Callout text" : "Text box contents";
  pop.hidden = false;
  const { w, h } = pageSize();
  const maxX = w * st.zoom - 250;
  const maxY = h * st.zoom - 110;
  pop.style.left = `${Math.max(0, Math.min(maxX, p.anchor[0]))}px`;
  pop.style.top = `${Math.max(0, Math.min(maxY, p.anchor[1]))}px`;
  setTimeout(() => popText.focus(), 0);
}

function closePopover() {
  st.pop = null;
  pop.hidden = true;
  drawOverlay();
}

async function popCommit() {
  const p = st.pop;
  if (!p) return;
  const text = popText.value;
  if (!text.trim() && p.mode !== "edit") {
    status("Type something first", true);
    return;
  }
  closePopover();
  if (p.mode === "note") return commit({ tool: "note", point: p.point, contents: text });
  if (p.mode === "text") return commit({ tool: "text", rect: p.rect, contents: text });
  if (p.mode === "callout") return commit({ tool: "callout", rect: p.rect, point: p.point, contents: text });
  await guarded(async () => {
    await api("PATCH", `/api/annots/${p.id}`, { contents: text });
    await afterAnnotChange();
    status("Updated");
  });
}

$("#pop-ok").addEventListener("click", popCommit);
$("#pop-cancel").addEventListener("click", closePopover);
popText.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    popCommit();
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    closePopover();
  }
  ev.stopPropagation();
});

// ---------- open / save ----------

let pendingProtection = null;
const pwModal = $("#pwmodal");
const protModal = $("#protmodal");

function wipeProtection(p) {
  if (!p) return;
  p.userPassword = "";
  p.ownerPassword = "";
}

function clearPasswordFields() {
  for (const id of ["pw-input", "prot-open", "prot-open2", "prot-owner"]) {
    const el = $(`#${id}`);
    if (el) el.value = "";
  }
}

let pwWait = null;
function askPassword({ lead, invalid }) {
  return new Promise((resolve) => {
    pwWait = resolve;
    $("#pw-lead").textContent = lead;
    $("#pw-err").hidden = !invalid;
    clearPasswordFields();
    pwModal.hidden = false;
    $("#pw-input").focus();
  });
}
function finishPassword(value) {
  pwModal.hidden = true;
  clearPasswordFields();
  const resolve = pwWait;
  pwWait = null;
  if (resolve) resolve(value);
}

function isPasswordError(e) {
  return e && e.status === 401 && (e.code === "password" || e.code === "password-required");
}

async function openPath(p) {
  status("Opening…");
  let password;
  for (;;) {
    let s;
    try {
      s = await api("POST", "/api/open", password === undefined ? { path: p } : { path: p, password });
    } catch (e) {
      password = undefined;
      if (!isPasswordError(e)) {
        status(e.message, true);
        return;
      }
      const again = e.code === "password";
      const entered = await askPassword({
        lead: again ? "That password did not open the file. Try again." : "This PDF needs a password to open.",
        invalid: again,
      });
      if (entered == null) {
        status("Open cancelled");
        return;
      }
      password = entered;
      continue;
    }
    password = undefined;
    onOpened(s);
    status(`Opened ${s.name}`);
    return;
  }
}

function onOpened(s) {
  st.rev++;
  cm.items = null;
  pendingProtection = null;
  st.zoom = 1;
  st.kinds = [];
  closeFind();
  setDoc(s, 0);
  loadKinds();
  buildThumbs();
  fitWidth();
  showPage();
  if (s.protection?.encrypted && !s.protection.userPassword) {
    const bits = [];
    if (!s.protection.print) bits.push("printing");
    if (!s.protection.copy) bits.push("copying");
    if (!s.protection.edit) bits.push("editing");
    status(bits.length ? `Opened with restrictions (${bits.join(", ")} off)` : "Opened a protected PDF");
  }
}

async function uploadFile(file) {
  if (!file) return;
  status("Opening…");
  let password;
  for (;;) {
    const headers = { "Content-Type": "application/pdf", "X-Filename": encodeURIComponent(file.name) };
    if (password !== undefined) headers["X-Password"] = encodeURIComponent(password);
    let s;
    try {
      s = await api("POST", "/api/open-upload", undefined, { body: file, headers });
    } catch (e) {
      password = undefined;
      if (!isPasswordError(e)) {
        status(e.message, true);
        return;
      }
      const again = e.code === "password";
      const entered = await askPassword({
        lead: again ? "That password did not open the file. Try again." : "This PDF needs a password to open.",
        invalid: again,
      });
      if (entered == null) {
        status("Open cancelled");
        return;
      }
      password = entered;
      continue;
    }
    password = undefined;
    onOpened(s);
    status(s.sourcePath ? `Opened ${s.name}` : `Opened ${s.name} (upload – Save will download a copy)`);
    return;
  }
}

async function doOpen() {
  if (st.doc?.dirty) status("Unsaved changes will be discarded if you open another file", true);
  try {
    const r = await api("POST", "/api/pick", { mode: "open" });
    if (r.path) await openPath(r.path);
  } catch {
    $("#filein").click();
  }
}

let protWait = null;

function syncProtFields() {
  const mode = document.querySelector('input[name="prot-mode"]:checked')?.value;
  $("#prot-fields").hidden = mode !== "password";
}

function askProtection({ purpose }) {
  return new Promise((resolve) => {
    protWait = resolve;
    const encrypted = !!st.doc?.protection?.encrypted;
    $("#prot-title").textContent = purpose === "save" ? "Save protection" : "Protect with password";
    $("#prot-ok").textContent = purpose === "save" ? "Save" : "Apply";
    $("#prot-lead").textContent = purpose === "save"
      ? "This file is protected. Choose what to write."
      : "Set a password, change permissions, or remove protection. This takes effect the next time you save.";
    $("#prot-keep-l").hidden = !encrypted;
    const mode = purpose === "save" && encrypted ? "keep" : "password";
    for (const el of document.querySelectorAll('input[name="prot-mode"]')) el.checked = el.value === mode;
    const p = st.doc?.protection;
    $("#prot-print").checked = !p || p.print !== false;
    $("#prot-copy").checked = !p || p.copy !== false;
    $("#prot-edit").checked = !p || p.edit !== false;
    $("#prot-err").hidden = true;
    clearPasswordFields();
    syncProtFields();
    protModal.hidden = false;
    if (mode === "password") $("#prot-open").focus();
  });
}

function finishProtection(value) {
  protModal.hidden = true;
  clearPasswordFields();
  const resolve = protWait;
  protWait = null;
  if (resolve) resolve(value);
}

function readProtectionForm() {
  const mode = document.querySelector('input[name="prot-mode"]:checked')?.value || "keep";
  if (mode !== "password") return { mode };
  const userPassword = $("#prot-open").value;
  const again = $("#prot-open2").value;
  const ownerPassword = $("#prot-owner").value;
  const print = $("#prot-print").checked;
  const copy = $("#prot-copy").checked;
  const edit = $("#prot-edit").checked;
  if (userPassword !== again) return { error: "Open password does not match." };
  const restricted = !print || !copy || !edit;
  if (!userPassword && !restricted) return { error: "Enter an open password, or turn off a permission." };
  if (restricted && !ownerPassword) return { error: "Enter a permissions password to enforce those restrictions." };
  if (restricted && ownerPassword === userPassword) return { error: "The permissions password must be different from the open password." };
  const enc = new TextEncoder();
  if (enc.encode(userPassword).length > 127 || enc.encode(ownerPassword).length > 127) return { error: "Password is too long." };
  return { mode: "password", userPassword, ownerPassword, print, copy, edit };
}

async function download(protection) {
  const mode = protection?.mode || "keep";
  if (mode === "keep") {
    const a = document.createElement("a");
    a.href = `/api/download?v=${Date.now()}`;
    a.download = st.doc?.name || "redline.pdf";
    document.body.append(a);
    a.click();
    a.remove();
    status("Downloaded a copy");
    return true;
  }
  const res = await fetch("/api/download", {
    method: "POST",
    headers: { "X-Redline": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ protection }),
  });
  const ct = res.headers.get("content-type") || "";
  if (!res.ok) {
    let msg = `${res.status}`;
    if (ct.includes("json")) {
      const data = await res.json();
      msg = data.error || msg;
    }
    status(msg, true);
    return false;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = st.doc?.name || "redline.pdf";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  if (st.doc) {
    st.doc.protection = {
      encrypted: mode === "password",
      method: mode === "password" ? "AES-256" : null,
      print: protection.print !== false,
      copy: protection.copy !== false,
      edit: protection.edit !== false,
      userPassword: !!protection.userPassword,
    };
  }
  status("Downloaded a copy");
  return true;
}

async function runSave(fn) {
  if (!st.doc) return;
  let picked;
  if (pendingProtection) picked = { protection: pendingProtection, fromPending: true };
  else if (st.doc.protection?.encrypted) {
    const protection = await askProtection({ purpose: "save" });
    if (!protection) return;
    picked = { protection, fromPending: false };
  } else picked = { protection: { mode: "keep" }, fromPending: false };
  let ok = false;
  try {
    ok = await fn(picked.protection);
  } finally {
    if (!picked.fromPending) wipeProtection(picked.protection);
  }
  if (ok && picked.fromPending) {
    wipeProtection(pendingProtection);
    pendingProtection = null;
  }
  if (ok) updateChrome();
}

async function doSave() {
  await runSave(async (protection) => {
    if (!st.doc.sourcePath) return download(protection);
    status("Saving…");
    const r = await guarded(() => api("POST", "/api/save", { protection }));
    if (!r) return false;
    if (r.protection) st.doc.protection = r.protection;
    setDirty(false);
    status(r.backup ? `Saved. Original kept as ${r.backup.split("/").pop()}` : "Saved");
    return true;
  });
}

async function doSaveAs() {
  await runSave(async (protection) => {
    let r;
    try {
      r = await api("POST", "/api/pick", { mode: "save" });
    } catch {
      return download(protection);
    }
    if (!r.path) return false;
    status("Saving…");
    const s = await guarded(() => api("POST", "/api/save-as", { path: r.path, protection }));
    if (!s) return false;
    st.doc.sourcePath = s.path;
    st.doc.name = s.path.split("/").pop();
    if (s.protection) st.doc.protection = s.protection;
    setDirty(false);
    status(`Saved as ${st.doc.name}`);
    return true;
  });
}

async function doProtect() {
  if (!st.doc) return;
  const protection = await askProtection({ purpose: "protect" });
  if (!protection) return;
  wipeProtection(pendingProtection);
  if (protection.mode === "keep") {
    pendingProtection = null;
    status("Keeping the current protection");
  } else {
    pendingProtection = protection;
    setDirty(true);
    status(protection.mode === "none" ? "Protection will be removed when you save" : "Password protection will be applied when you save");
  }
  updateChrome();
}

$("#pw-ok").addEventListener("click", () => finishPassword($("#pw-input").value));
$("#pw-cancel").addEventListener("click", () => finishPassword(null));
$("#pw-close").addEventListener("click", () => finishPassword(null));
pwModal.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    finishPassword(null);
  } else if (ev.key === "Enter") {
    ev.preventDefault();
    ev.stopPropagation();
    finishPassword($("#pw-input").value);
  }
});
$("#prot-ok").addEventListener("click", () => {
  const v = readProtectionForm();
  if (v.error) {
    $("#prot-err").hidden = false;
    $("#prot-err").textContent = v.error;
    return;
  }
  finishProtection(v);
});
$("#prot-cancel").addEventListener("click", () => finishProtection(null));
$("#prot-close").addEventListener("click", () => finishProtection(null));
protModal.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    finishProtection(null);
  } else if (ev.key === "Enter" && ev.target instanceof HTMLInputElement) {
    ev.preventDefault();
    ev.stopPropagation();
    $("#prot-ok").click();
  }
});
for (const el of document.querySelectorAll('input[name="prot-mode"]')) el.addEventListener("change", syncProtFields);

$("#filein").addEventListener("change", (ev) => {
  uploadFile(ev.target.files[0]);
  ev.target.value = "";
});

// ---------- chrome wiring ----------

function setTool(t) {
  st.tool = t;
  st.vertices = [];
  st.calloutTip = null;
  st.selected = t === "select" ? st.selected : null;
  $$(".tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
  $("#stamps").hidden = t !== "stamp";
  $("#cloudopt").hidden = t !== "cloud";
  $("#measureopt").hidden = t !== "measure";
  viewer.dataset.tool = t;
  const c = colorName(t);
  $$(".swatch").forEach((s) => s.classList.toggle("active", t !== "select" && t !== "stamp" && s.dataset.color === c));
  closePopover();
}

$$(".tool").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
$$("#stamps .stamp[data-stamp]").forEach((b) =>
  b.addEventListener("click", () => {
    st.stamp = b.dataset.stamp;
    st.customStamp = null;
    $$("#stamps .stamp[data-stamp]").forEach((s) => s.classList.toggle("active", s === b));
    $$("#custom-stamps .stamp").forEach((s) => s.classList.remove("active"));
  }),
);
$("#cloud-rect").addEventListener("click", () => { st.cloudPoly = false; st.vertices = []; $("#cloud-rect").classList.add("active"); $("#cloud-poly").classList.remove("active"); drawOverlay(); });
$("#cloud-poly").addEventListener("click", () => { st.cloudPoly = true; st.vertices = []; $("#cloud-poly").classList.add("active"); $("#cloud-rect").classList.remove("active"); drawOverlay(); status("Click points, then double-click to finish cloud"); });
$$(".swatch").forEach((s) =>
  s.addEventListener("click", async () => {
    const sel = st.tool === "select" && st.annots.find((a) => a.id === st.selected);
    if (sel && sel.kind !== "stamp") {
      await guarded(async () => {
        await api("PATCH", `/api/annots/${sel.id}`, { color: s.dataset.color });
        await afterAnnotChange();
      });
      return;
    }
    if (st.tool === "select" || st.tool === "stamp") return;
    st.colors[st.tool] = s.dataset.color;
    setTool(st.tool);
  }),
);

$("#btn-open").addEventListener("click", doOpen);
$("#btn-open-empty").addEventListener("click", doOpen);
$("#btn-save").addEventListener("click", doSave);
$("#btn-saveas").addEventListener("click", doSaveAs);
$("#btn-protect").addEventListener("click", doProtect);
$("#btn-prev").addEventListener("click", () => gotoPage(st.page - 1));
$("#btn-next").addEventListener("click", () => gotoPage(st.page + 1));
$("#btn-zin").addEventListener("click", () => setZoom(st.zoom * 1.25, true));
$("#btn-zout").addEventListener("click", () => setZoom(st.zoom / 1.25, true));
$("#zoomind").addEventListener("click", fitWidth);
$("#btn-rotl").addEventListener("click", () => pageOp("/api/pages/rotate", { page: st.page, delta: -90 }, "Rotated left"));
$("#btn-rotr").addEventListener("click", () => pageOp("/api/pages/rotate", { page: st.page, delta: 90 }, "Rotated right"));
$("#btn-insert").addEventListener("click", () =>
  pageOp("/api/pages/insert", { at: st.page + 1, like: st.page }, "Inserted blank page"),
);
$("#btn-delete").addEventListener("click", () => {
  if (!$("#btn-delete").dataset.armed) {
    $("#btn-delete").dataset.armed = "1";
    $("#btn-delete").textContent = "Confirm?";
    status(`Click again to delete page ${st.page + 1}`);
    setTimeout(() => {
      delete $("#btn-delete").dataset.armed;
      $("#btn-delete").textContent = "Delete";
    }, 2500);
    return;
  }
  delete $("#btn-delete").dataset.armed;
  $("#btn-delete").textContent = "Delete";
  pageOp("/api/pages/delete", { page: st.page }, "Deleted page");
});
$("#btn-up").addEventListener("click", () => pageOp("/api/pages/move", { from: st.page, to: st.page - 1 }, "Moved page up"));
$("#btn-down").addEventListener("click", () =>
  pageOp("/api/pages/move", { from: st.page, to: st.page + 1 }, "Moved page down"),
);

viewer.addEventListener("scroll", () => {
  if (!st.doc) return;
  clearTimeout(imgTimer);
  imgTimer = setTimeout(paintTiles, 60);
}, { passive: true });

viewer.addEventListener(
  "wheel",
  (ev) => {
    if (!ev.ctrlKey || !st.doc) return;
    ev.preventDefault();
    setZoom(st.zoom * (ev.deltaY < 0 ? 1.1 : 1 / 1.1), false);
  },
  { passive: false },
);

const TOOL_KEYS = { v: "select", h: "highlight", u: "underline", k: "strikeout", n: "note", t: "text", p: "pen", l: "line", a: "arrow", b: "box", c: "cloud", g: "polygon", y: "polyline", q: "callout", m: "measure", s: "stamp" };
window.addEventListener("keydown", (ev) => {
  if (!pwModal.hidden || !protModal.hidden) return;
  const typing = ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLInputElement;
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && ev.key.toLowerCase() === "s") {
    ev.preventDefault();
    if (ev.shiftKey) doSaveAs();
    else doSave();
    return;
  }
  if (!sendModal.hidden || !pagesModal.hidden || !dropModal.hidden || !pwModal.hidden || !protModal.hidden) return;
  if (mod && !typing && ev.key.toLowerCase() === "z") {
    ev.preventDefault();
    undoRedo(ev.shiftKey ? "redo" : "undo");
    return;
  }
  if (mod && !typing && ev.key.toLowerCase() === "y") {
    ev.preventDefault();
    undoRedo("redo");
    return;
  }
  if (mod && !typing && ev.key.toLowerCase() === "c" && st.sel) {
    ev.preventDefault();
    copySelection();
    return;
  }
  if (mod && !typing && ev.key.toLowerCase() === "a" && st.doc && st.tmap?.chars.length) {
    ev.preventDefault();
    st.sel = { a: 0, b: st.tmap.chars.length - 1 };
    drawOverlay();
    placeSelTools();
    return;
  }
  if (mod && ev.key.toLowerCase() === "e") {
    ev.preventDefault();
    openSend();
    return;
  }
  if (mod && ev.key.toLowerCase() === "o") {
    ev.preventDefault();
    if (ev.shiftKey) doOcr();
    else doOpen();
    return;
  }
  if (mod && ev.shiftKey && ev.key.toLowerCase() === "m") {
    ev.preventDefault();
    if (st.doc) toggleComments();
    return;
  }
  if (mod && ev.key.toLowerCase() === "f") {
    ev.preventDefault();
    if (st.doc) openFind();
    return;
  }
  if (mod && (ev.key === "=" || ev.key === "+")) {
    ev.preventDefault();
    setZoom(st.zoom * 1.25, true);
    return;
  }
  if (mod && ev.key === "-") {
    ev.preventDefault();
    setZoom(st.zoom / 1.25, true);
    return;
  }
  if (mod && ev.key === "0") {
    ev.preventDefault();
    fitWidth();
    return;
  }
  if (typing || mod || ev.altKey || !st.doc) return;
  if ((ev.key === "Delete" || ev.key === "Backspace") && st.selected) {
    ev.preventDefault();
    deleteSelected();
  } else if (ev.key === "Escape") {
    st.selected = null;
    st.drag = null;
    clearSel();
    closePopover();
  } else if (ev.key === "PageDown" || ev.key === "ArrowRight") {
    ev.preventDefault();
    gotoPage(st.page + 1);
  } else if (ev.key === "PageUp" || ev.key === "ArrowLeft") {
    ev.preventDefault();
    gotoPage(st.page - 1);
  } else if (TOOL_KEYS[ev.key.toLowerCase()]) {
    setTool(TOOL_KEYS[ev.key.toLowerCase()]);
  }
});

// drag and drop a PDF into the window
let dragDepth = 0;
window.addEventListener("dragenter", (ev) => {
  if (ev.dataTransfer?.types?.includes("Files")) {
    dragDepth++;
    document.body.classList.add("dragging");
  }
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove("dragging");
});
window.addEventListener("dragover", (ev) => ev.preventDefault());
window.addEventListener("drop", (ev) => {
  ev.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const files = [...(ev.dataTransfer?.files || [])];
  if (!files.length) return;
  if (st.doc) askDrop(files);
  else if (files.length === 1) uploadFile(files[0]);
  else combineUploads(files);
});

// several files dropped with nothing open: open the first, append the rest
async function combineUploads(files) {
  await uploadFile(files[0]);
  if (!st.doc) return;
  dropped = files.slice(1);
  await insertDropped(st.doc.pageCount);
}

window.addEventListener("beforeunload", (ev) => {
  if (st.doc?.dirty) {
    ev.preventDefault();
    ev.returnValue = "";
  }
});

window.addEventListener("resize", () => drawOverlay());

// ---------- send (email / handoff / LocalSend) ----------

const send = { via: "email", cfg: null, devices: [], device: null, busy: false, scanning: false };
const sendModal = $("#sendmodal");
const GO_LABEL = { email: "Open email", handoff: "Hand off", localsend: "Send" };

function sendMsg(text, kind = "") {
  const el = $("#send-msg");
  el.textContent = text || "";
  el.className = `send-msg ${kind}`;
  el.title = text || "";
}

function setVia(via) {
  send.via = via;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.via === via));
  $$(".pane").forEach((p) => (p.hidden = p.dataset.pane !== via));
  $("#send-go").textContent = GO_LABEL[via];
  sendMsg("");
  if (via === "localsend" && !send.devices.length && !send.scanning) scanDevices();
  updateSendButton();
}

function updateSendButton() {
  const c = send.cfg;
  let ok = !send.busy && !!c;
  if (ok && send.via === "email") ok = c.email.ready;
  if (ok && send.via === "handoff") ok = !!c.handoff?.ready;
  if (ok && send.via === "localsend") ok = !!send.device;
  $("#send-go").disabled = !ok;
}

function devButton(title, meta, active, online, onPick) {
  const b = document.createElement("button");
  b.className = "ls-dev" + (active ? " active" : "");
  const name = document.createElement("span");
  const dot = document.createElement("i");
  dot.className = "dot" + (online === false ? " off" : "");
  name.append(dot, title);
  const m = document.createElement("small");
  m.textContent = meta;
  b.append(name, m);
  b.addEventListener("click", onPick);
  b.addEventListener("dblclick", () => doSend());
  return b;
}

function renderHandoff() {
  const h = send.cfg?.handoff;
  const detail = $("#handoff-detail");
  detail.replaceChildren();
  const line = (text) => {
    const div = document.createElement("div");
    div.textContent = text;
    detail.append(div);
  };
  if (h?.dropFolder) line(`Drop folder: ${h.dropFolder}`);
  if (h?.endpoint) line(`Endpoint: ${h.endpoint}`);
  if (!h?.dropFolder && !h?.endpoint) line("No drop folder or endpoint configured.");
  $("#handoff-hint").textContent = h?.reason
    ? "Add them in settings.json in the app data folder (see settings.example.json)."
    : "The PDF is sent to every target listed above.";
}

async function loadSendConfig() {
  send.cfg = await api("GET", "/api/send/config");
  const e = send.cfg.email;
  $("#email-setup").hidden = !e.reason;
  $("#email-reason").textContent = e.reason || "";
  $("#em-from").textContent = e.from || "your mail account";
  renderHandoff();
  updateSendButton();
}

function renderDevices() {
  const list = $("#ls-list");
  list.textContent = "";
  if (!send.devices.length) {
    const d = document.createElement("div");
    d.className = "ls-empty";
    d.textContent = send.scanning ? "Searching…" : "No LocalSend devices found.";
    list.append(d);
    return;
  }
  for (const dev of send.devices) {
    const meta = [dev.deviceModel, dev.ip].filter(Boolean).join(" · ");
    list.append(
      devButton(dev.alias, meta, send.device === dev, true, () => {
        send.device = dev;
        renderDevices();
        updateSendButton();
      }),
    );
  }
}

async function scanDevices() {
  const prev = send.device?.fingerprint || null;
  send.scanning = true;
  send.device = null;
  send.devices = [];
  $("#ls-state").textContent = "Looking for devices…";
  $("#ls-refresh").disabled = true;
  renderDevices();
  updateSendButton();
  try {
    const r = await api("GET", "/api/send/localsend/devices");
    send.devices = r.devices || [];
    send.device = send.devices.find((d) => prev && d.fingerprint === prev) || null;
    const n = send.devices.length;
    $("#ls-state").textContent = `${n} device${n === 1 ? "" : "s"} on the network`;
  } catch (e) {
    $("#ls-state").textContent = `Search failed: ${e.message}`;
  } finally {
    send.scanning = false;
    $("#ls-refresh").disabled = false;
    renderDevices();
    updateSendButton();
  }
}

async function openSend() {
  if (!st.doc) return;
  closePopover();
  const name = st.doc.name || "Untitled.pdf";
  $("#send-name").textContent = name;
  if (!$("#em-subject").value || $("#em-subject").dataset.auto === "1") {
    $("#em-subject").value = name.replace(/\.pdf$/i, "");
    $("#em-subject").dataset.auto = "1";
  }
  sendModal.hidden = false;
  setVia(send.via);
  sendMsg(st.doc.dirty ? "Unsaved markup will be included" : "");
  try {
    await loadSendConfig();
  } catch (e) {
    sendMsg(e.message, "err");
  }
}

function closeSend() {
  if (send.busy) return;
  sendModal.hidden = true;
}

async function doSend() {
  if ($("#send-go").disabled) return;
  const via = send.via;
  const body = { via };
  if (via === "email") body.subject = $("#em-subject").value;
  if (via === "localsend") body.device = send.device;
  send.busy = true;
  updateSendButton();
  sendMsg(
    {
      email: "Opening Thunderbird…",
      handoff: "Handing off…",
      localsend: `Waiting for ${send.device?.alias || "the device"} to accept…`,
    }[via],
  );
  try {
    const r = await api("POST", "/api/send", body);
    const handoffParts = [];
    if (r.dropped) handoffParts.push(`Copied to ${r.dropped}`);
    if (r.posted) handoffParts.push("Posted to the endpoint");
    const done = {
      email: r.accountReady ? "Email opened in Thunderbird" : "Thunderbird opened. Add the sender address from settings, then send again",
      handoff: handoffParts.join(". ") || "Sent",
      localsend: `Sent to ${r.to}`,
    }[via];
    sendMsg(done, "ok");
    status(done);
    send.busy = false;
    if (via !== "email" || r.accountReady) {
      setTimeout(() => {
        if (!send.busy) sendModal.hidden = true;
      }, 1100);
    }
  } catch (e) {
    sendMsg(e.message, "err");
  } finally {
    send.busy = false;
    updateSendButton();
  }
}

$("#btn-send").addEventListener("click", openSend);
$("#send-close").addEventListener("click", closeSend);
$("#send-cancel").addEventListener("click", closeSend);
$("#send-go").addEventListener("click", doSend);
$("#ls-refresh").addEventListener("click", scanDevices);
$$(".tab").forEach((t) => t.addEventListener("click", () => setVia(t.dataset.via)));
$("#em-subject").addEventListener("input", (ev) => (ev.target.dataset.auto = "0"));
$("#email-recheck").addEventListener("click", () => guarded(loadSendConfig));
$("#email-setup-btn").addEventListener("click", async () => {
  await guarded(() => api("POST", "/api/send/email-setup", {}));
  sendMsg("Add the sender address from settings in Thunderbird, then press Check again");
});
sendModal.addEventListener("mousedown", (ev) => {
  if (ev.target === sendModal) closeSend();
});
sendModal.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    ev.stopPropagation();
    closeSend();
  } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    doSend();
  }
});

// ---------- boot ----------

(async function boot() {
  setTool("select");
  const params = new URLSearchParams(location.search);
  const openParam = params.get("open");
  if (openParam) {
    history.replaceState(null, "", "/");
    await openPath(openParam);
    return;
  }
  try {
    const s = await api("GET", "/api/doc");
    onOpened(s);
    if (s.dirty) status("Restored the open document (unsaved changes)");
  } catch {
    /* nothing open yet */
  }
})();

// ---------- OCR ----------
// Lazy like Acrobat: the page on screen (plus a short look-ahead) is read as soon as it is shown;
// the whole document only on "Read all". Small scanned documents are read fully on open by the server.

const LOOKAHEAD = [0, 1, 2, -1];
let ocrPollTimer = null;
let ocrLastRev = -1;

function applyOcrStatus(s) {
  if (!st.doc || !s) return;
  const before = st.kinds[st.page];
  st.kinds = s.kinds || st.kinds;
  if (before !== st.kinds[st.page] && st.kinds[st.page] !== "none") loadTextMap();
  st.ocrRunning = !!s.running;
  st.ocrQueued = (s.queued || []).length;
  st.ocrUnread = s.unread ?? st.kinds.filter((k) => k === "none").length;
  updateKindChip();
  updateFindUnread();
  const btn = $("#btn-ocr");
  btn.textContent = s.running || st.ocrQueued ? "Stop" : "Read all";
  btn.title = s.running || st.ocrQueued ? "Stop reading pages" : "Read every scanned page so the whole document can be searched";
  if (s.running) {
    const el = $("#status");
    el.classList.remove("err");
    el.textContent = `Reading page ${s.page + 1}${st.ocrQueued ? ` · ${st.ocrQueued} more queued` : ""}`;
    clearTimeout(statusTimer);
  }
  if (s.error) status(s.error, true);
  if (s.rev !== undefined && s.rev !== ocrLastRev) {
    ocrLastRev = s.rev;
    if (st.find?.q) runFind(st.find.q, true);
  }
}

async function ocrPoll() {
  clearTimeout(ocrPollTimer);
  if (!st.doc) return;
  let s;
  try { s = await api("GET", "/api/ocr"); } catch { return; }
  const wasRunning = st.ocrRunning || st.ocrQueued;
  applyOcrStatus(s);
  if (s.running || (s.queued || []).length) {
    ocrPollTimer = setTimeout(ocrPoll, 700);
  } else if (wasRunning) {
    status(st.ocrUnread ? `Done · ${st.ocrUnread} scanned page${st.ocrUnread === 1 ? "" : "s"} not read yet` : "All pages are searchable");
  }
}

/** Ask the server to read the page on screen and its neighbours first. */
async function ocrAround(page) {
  if (!st.doc) return;
  const n = st.doc.pageCount;
  const pages = LOOKAHEAD.map((d) => page + d).filter((i) => i >= 0 && i < n);
  const need = st.kinds.length ? pages.filter((i) => st.kinds[i] === "none") : pages;
  if (!need.length) return;
  try {
    applyOcrStatus(await api("POST", "/api/ocr", { pages: need, front: true }));
    ocrPoll();
  } catch (e) {
    status(e.message, true);
  }
}

async function readAll() {
  if (!st.doc) return;
  if (st.ocrRunning || st.ocrQueued) {
    try { applyOcrStatus(await api("POST", "/api/ocr/cancel")); status("Stopped"); } catch (e) { status(e.message, true); }
    return;
  }
  if (!st.ocrUnread) { status("All pages are already searchable"); return; }
  try {
    applyOcrStatus(await api("POST", "/api/ocr", { pages: "all" }));
    ocrPoll();
  } catch (e) {
    status(e.message, true);
  }
}
$("#btn-ocr").addEventListener("click", readAll);
const doOcr = readAll;

// ---------- Find ----------

const findBar = $("#findbar");
const findQ = $("#find-q");
let findTimer = null;

function openFind() {
  findBar.hidden = false;
  document.body.classList.add("has-find");
  updateFindUnread();
  findQ.focus();
  findQ.select();
  layoutPage();
}

function closeFind() {
  findBar.hidden = true;
  document.body.classList.remove("has-find");
  st.find = null;
  $("#find-count").textContent = "";
  drawOverlay();
  if (st.doc) layoutPage();
}

async function runFind(q, keepPos = false) {
  q = (q || "").trim();
  if (!st.doc || !q) {
    st.find = null;
    $("#find-count").textContent = "";
    drawOverlay();
    return;
  }
  let r;
  try { r = await api("GET", `/api/search?q=${encodeURIComponent(q)}`); } catch (e) { status(e.message, true); return; }
  if (findQ.value.trim() !== q) return; // stale
  const prev = st.find;
  st.find = { q, total: r.total, pages: r.pages, pi: -1, hi: -1 };
  if (r.total) {
    // first hit on or after the current page, unless keeping position
    let pg = keepPos && prev ? r.pages.find((p) => p.page === prev.pi) : null;
    if (!pg) pg = r.pages.find((p) => p.page >= st.page) || r.pages[0];
    st.find.pi = pg.page;
    st.find.hi = keepPos && prev && pg.page === prev.pi ? Math.min(prev.hi, pg.hits.length - 1) : 0;
    if (st.find.pi !== st.page) gotoPage(st.find.pi);
  }
  updateFindCount();
  drawOverlay();
}

function flatIndex() {
  if (!st.find || st.find.pi < 0) return 0;
  let n = 0;
  for (const p of st.find.pages) {
    if (p.page === st.find.pi) return n + st.find.hi + 1;
    n += p.hits.length;
  }
  return 0;
}

function updateFindUnread() {
  const el = $("#find-unread");
  if (!el) return;
  const n = st.ocrUnread || 0;
  el.hidden = !n || findBar.hidden;
  $("#find-unread-n").textContent = `${n} scanned page${n === 1 ? "" : "s"} not read yet`;
}

function updateFindCount() {
  const el = $("#find-count");
  if (!st.find) { el.textContent = ""; return; }
  el.textContent = st.find.total ? `${flatIndex()} / ${st.find.total}` : "No matches";
  el.classList.toggle("err", !st.find.total);
}

function stepFind(dir) {
  const f = st.find;
  if (!f || !f.total) return;
  let k = f.pages.findIndex((p) => p.page === f.pi);
  if (k < 0) { k = 0; f.hi = -1; }
  let hi = f.hi + dir;
  while (hi < 0 || hi >= f.pages[k].hits.length) {
    k = (k + dir + f.pages.length) % f.pages.length;
    hi = dir > 0 ? 0 : f.pages[k].hits.length - 1;
  }
  f.pi = f.pages[k].page;
  f.hi = hi;
  if (f.pi !== st.page) gotoPage(f.pi);
  updateFindCount();
  drawOverlay();
  scrollToHit();
}

function scrollToHit() {
  const f = st.find;
  const pg = f?.pages.find((p) => p.page === f.pi);
  const q = pg?.hits[f.hi]?.[0];
  if (!q) return;
  const y = q[1] * st.zoom;
  const x = q[0] * st.zoom;
  const top = viewer.scrollTop, bottom = top + viewer.clientHeight;
  if (y < top + 40 || y > bottom - 40) viewer.scrollTop = Math.max(0, y - viewer.clientHeight / 2);
  const left = viewer.scrollLeft, right = left + viewer.clientWidth;
  if (x < left + 40 || x > right - 40) viewer.scrollLeft = Math.max(0, x - viewer.clientWidth / 2);
}

findQ.addEventListener("input", () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => runFind(findQ.value), 180);
});
findQ.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    if (st.find && findQ.value.trim() === st.find.q) stepFind(ev.shiftKey ? -1 : 1);
    else runFind(findQ.value);
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    closeFind();
  }
});
$("#find-next").addEventListener("click", () => stepFind(1));
$("#find-prev").addEventListener("click", () => stepFind(-1));
$("#find-close").addEventListener("click", closeFind);
$("#find-readall").addEventListener("click", readAll);
$("#btn-find").addEventListener("click", openFind);
$("#find-copy").addEventListener("click", async () => {
  if (!st.doc) return;
  try {
    const res = await fetch(`/api/text?page=${st.page}`);
    const text = await res.text();
    await navigator.clipboard.writeText(text);
    status(`Copied ${text.split(/\s+/).filter(Boolean).length} words from page ${st.page + 1}`);
  } catch (e) {
    status(`Copy failed: ${e.message}`, true);
  }
});

// ---------- text selection ----------
// The server gives every character's quad (page space); selection is a range of character
// indices in reading order. Works on native text and on OCR'd pages alike.

const selTools = $("#seltools");

async function loadTextMap() {
  if (!st.doc) return;
  const page = st.page;
  st.tmap = null;
  canvas.classList.remove("over-text");
  try {
    const m = await api("GET", `/api/textmap?page=${page}`);
    if (page !== st.page) return;
    const chars = [];
    m.lines.forEach((ln, li) => ln.chars.forEach((ch) => chars.push({ c: ch.c, q: ch.q, line: li })));
    st.tmap = { page, lines: m.lines, chars };
  } catch {
    st.tmap = null;
  }
}

function quadBox(q) {
  return [Math.min(q[0], q[2], q[4], q[6]), Math.min(q[1], q[3], q[5], q[7]), Math.max(q[0], q[2], q[4], q[6]), Math.max(q[1], q[3], q[5], q[7])];
}

/** Index of the character under (x,y) in CSS px. nearest=true snaps to the closest char on the closest line. */
function charAt(x, y, nearest, maxDist = Infinity) {
  const m = st.tmap;
  if (!m || !m.chars.length) return -1;
  const z = st.zoom;
  const px = x / z, py = y / z;
  maxDist = maxDist / z;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < m.chars.length; i++) {
    const [x0, y0, x1, y1] = quadBox(m.chars[i].q);
    const h = y1 - y0;
    if (px >= x0 && px <= x1 && py >= y0 - h * 0.15 && py <= y1 + h * 0.15) return i;
    if (nearest) {
      const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
      const dy = py < y0 ? y0 - py : py > y1 ? py - y1 : 0;
      const d = dy * 4 + dx; // stay on the line you are on
      if (d < bestD) { bestD = d; best = i; }
    }
  }
  return nearest && bestD <= maxDist ? best : -1;
}

function clearSel() {
  st.sel = null;
  selTools.hidden = true;
}

function selText() {
  if (!st.sel || !st.tmap) return "";
  let out = "", lastLine = -1;
  for (let i = st.sel.a; i <= st.sel.b; i++) {
    const ch = st.tmap.chars[i];
    if (lastLine >= 0 && ch.line !== lastLine) out += "\n";
    out += ch.c;
    lastLine = ch.line;
  }
  return out.replace(/[ \t]+\n/g, "\n").trim();
}

/** One quad per selected line (mupdf order: ul, ur, ll, lr). perChar=true returns a quad per character instead. */
function selQuads(perChar = false) {
  if (!st.sel || !st.tmap) return [];
  const chars = st.tmap.chars;
  if (perChar) {
    const out = [];
    for (let i = st.sel.a; i <= st.sel.b; i++) if (chars[i].c.trim()) out.push(chars[i].q);
    return out;
  }
  const out = [];
  let i = st.sel.a;
  while (i <= st.sel.b) {
    const line = chars[i].line;
    let j = i;
    while (j + 1 <= st.sel.b && chars[j + 1].line === line) j++;
    // trim whitespace at both ends of the run
    let s = i, e = j;
    while (s < e && !chars[s].c.trim()) s++;
    while (e > s && !chars[e].c.trim()) e--;
    if (chars[s].c.trim()) {
      const f = chars[s].q, l = chars[e].q;
      out.push([f[0], f[1], l[2], l[3], f[4], f[5], l[6], l[7]]);
    }
    i = j + 1;
  }
  return out;
}

function snapSelToWords() {
  if (!st.sel || !st.tmap) return;
  const chars = st.tmap.chars;
  let { a, b } = st.sel;
  const isWord = (i) => i >= 0 && i < chars.length && !!chars[i].c.trim();
  while (isWord(a - 1) && chars[a - 1].line === chars[a].line) a--;
  while (isWord(b + 1) && chars[b + 1].line === chars[b].line) b++;
  while (a < b && !isWord(a)) a++;
  while (b > a && !isWord(b)) b--;
  st.sel = { a, b };
}

function selectLine(i) {
  const chars = st.tmap.chars;
  let a = i, b = i;
  while (a > 0 && chars[a - 1].line === chars[i].line) a--;
  while (b < chars.length - 1 && chars[b + 1].line === chars[i].line) b++;
  st.sel = { a, b };
}

function placeSelTools() {
  if (!st.sel || !st.tmap) { selTools.hidden = true; return; }
  const qs = selQuads();
  if (!qs.length) { selTools.hidden = true; return; }
  const last = quadBox(qs[qs.length - 1]);
  const z = st.zoom;
  selTools.hidden = false;
  const x = Math.max(0, Math.min(last[2] * z - selTools.offsetWidth, canvas.clientWidth - selTools.offsetWidth - 4));
  selTools.style.left = `${x}px`;
  selTools.style.top = `${last[3] * z + 6}px`;
}

async function copySelection() {
  const text = selText();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    status(`Copied ${text.split(/\s+/).filter(Boolean).length} words`);
  } catch (e) {
    status(`Copy failed: ${e.message}`, true);
  }
}

selTools.addEventListener("pointerdown", (ev) => ev.stopPropagation());
selTools.addEventListener("click", (ev) => {
  const act = ev.target.closest("button")?.dataset.act;
  if (!act) return;
  if (act === "copy") { copySelection(); return; }
  snapSelToWords();
  const quads = selQuads();
  const contents = selText().slice(0, 500);
  clearSel();
  drawOverlay();
  if (quads.length) commit({ tool: act, quads: quads.map((q) => q.map((v) => v * st.zoom)), contents });
});

// ---------- Pages: insert from file / combine / extract / split / delete many ----------

const pagesMenu = $("#pages-menu");
const pagesModal = $("#pagesmodal");
const pg = { act: null, files: [], cfiles: [] };

$("#btn-pages").addEventListener("click", (ev) => {
  ev.stopPropagation();
  pagesMenu.hidden = !pagesMenu.hidden;
});
window.addEventListener("click", () => (pagesMenu.hidden = true));
pagesMenu.addEventListener("click", (ev) => {
  const act = ev.target.closest("button")?.dataset.act;
  if (act) openPages(act);
});

const PG_TITLE = { "insert-file": "Insert from file", combine: "Combine files", extract: "Extract pages", split: "Split document", "delete-many": "Delete pages" };
const PG_GO = { "insert-file": "Insert", combine: "Combine", extract: "Extract", split: "Split", "delete-many": "Delete" };

function pgMsg(text, kind = "") {
  const el = $("#pg-msg");
  el.textContent = text || "";
  el.className = `send-msg ${kind}`;
}

function openPages(act) {
  if (!st.doc && act !== "combine") return;
  pg.act = act;
  pagesMenu.hidden = true;
  $("#pg-title").textContent = PG_TITLE[act];
  $("#pg-go").textContent = PG_GO[act];
  $$("#pagesmodal .pane").forEach((p) => (p.hidden = p.dataset.pg !== act));
  pgMsg("");
  if (act === "extract") $("#pg-xpages").value = String(st.page + 1);
  if (act === "delete-many") $("#pg-dpages").value = String(st.page + 1);
  if (act === "split") {
    $("#pg-sbase").value = (st.doc?.name || "document").replace(/\.pdf$/i, "");
    $("#pg-severy").value = "1";
  }
  renderFileList();
  pagesModal.hidden = false;
  const first = $(`#pagesmodal .pane[data-pg="${act}"] input, #pagesmodal .pane[data-pg="${act}"] select`);
  first?.focus();
}

function closePages() {
  pagesModal.hidden = true;
}

function renderFileList() {
  for (const [id, list] of [["#pg-files", pg.files], ["#pg-cfiles", pg.cfiles]]) {
    const box = $(id);
    box.textContent = "";
    if (!list.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "No files chosen";
      box.append(e);
      continue;
    }
    list.forEach((f, i) => {
      const row = document.createElement("div");
      row.className = "f";
      const up = document.createElement("button"); up.textContent = "▲"; up.title = "Move up"; up.disabled = i === 0;
      const dn = document.createElement("button"); dn.textContent = "▼"; dn.title = "Move down"; dn.disabled = i === list.length - 1;
      const name = document.createElement("span"); name.textContent = f.replace(/^.*\//, ""); name.title = f;
      const rm = document.createElement("button"); rm.textContent = "×"; rm.title = "Remove";
      up.onclick = () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; renderFileList(); };
      dn.onclick = () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; renderFileList(); };
      rm.onclick = () => { list.splice(i, 1); renderFileList(); };
      row.append(up, dn, name, rm);
      box.append(row);
    });
  }
  $("#pg-take").disabled = pg.files.length !== 1;
}

async function pickFiles(into) {
  try {
    const r = await api("POST", "/api/pick", { mode: "files" });
    if (r.paths) { into.push(...r.paths); renderFileList(); }
  } catch (e) {
    pgMsg(e.message, "err");
  }
}
$("#pg-pick-files").addEventListener("click", () => pickFiles(pg.files));
$("#pg-pick-cfiles").addEventListener("click", () => pickFiles(pg.cfiles));
$("#pg-smode").addEventListener("change", () => {
  const m = $("#pg-smode").value;
  $("#pg-severy-l").hidden = m !== "every";
  $("#pg-sranges-l").hidden = m !== "ranges";
});

function afterPagesChanged(s, label) {
  st.rev++;
  cm.items = null;
  setDoc(s, s.page);
  buildThumbs();
  showPage();
  setDirty(true);
  status(label);
}

async function runPages() {
  const act = pg.act;
  pgMsg("Working…");
  $("#pg-go").disabled = true;
  try {
    if (act === "insert-file") {
      if (!pg.files.length) throw new Error("Choose at least one file");
      const where = $("#pg-where").value;
      const at = where === "after" ? st.page + 1 : where === "before" ? st.page : where === "start" ? 0 : st.doc.pageCount;
      const body = { paths: pg.files, at };
      const take = $("#pg-take").value.trim();
      if (pg.files.length === 1 && take) body.pages = take;
      const s = await api("POST", "/api/pages/insert-file", body);
      pg.files = [];
      closePages();
      afterPagesChanged(s, `Inserted ${s.inserted} page${s.inserted === 1 ? "" : "s"}`);
    } else if (act === "combine") {
      if (pg.cfiles.length < 1) throw new Error("Choose the files to combine");
      if (st.doc?.dirty && !confirm("The current document has unsaved changes. Combine into a new document anyway?")) throw new Error("Cancelled");
      const s = await api("POST", "/api/combine", { paths: pg.cfiles });
      pg.cfiles = [];
      closePages();
      onOpened(s);
      status(`Combined ${s.combined} files · ${s.pageCount} pages · Save As to keep it`);
    } else if (act === "extract") {
      const pages = $("#pg-xpages").value.trim();
      if (!pages) throw new Error("Which pages?");
      const suggest = (st.doc.name || "document").replace(/\.pdf$/i, "") + ` pages ${pages.replace(/\s+/g, "")}.pdf`;
      const r = await api("POST", "/api/pick", { mode: "save", suggest });
      if (!r.path) throw new Error("Cancelled");
      const s = await api("POST", "/api/pages/extract", { pages, path: r.path, remove: $("#pg-xremove").checked, current: st.page });
      closePages();
      if (s.removed) afterPagesChanged(s, `Extracted ${s.pages} page${s.pages === 1 ? "" : "s"} to ${s.path.replace(/^.*\//, "")} and removed them`);
      else status(`Extracted ${s.pages} page${s.pages === 1 ? "" : "s"} to ${s.path.replace(/^.*\//, "")}`);
    } else if (act === "split") {
      const mode = $("#pg-smode").value;
      const r = await api("POST", "/api/pick", { mode: "folder" });
      if (!r.path) throw new Error("Cancelled");
      const s = await api("POST", "/api/pages/split", { mode, every: Number($("#pg-severy").value) || 1, ranges: $("#pg-sranges").value, dir: r.path, base: $("#pg-sbase").value });
      closePages();
      status(`Split into ${s.files.length} file${s.files.length === 1 ? "" : "s"} in ${r.path.replace(/^.*\//, "")}`);
    } else if (act === "delete-many") {
      const pages = $("#pg-dpages").value.trim();
      if (!pages) throw new Error("Which pages?");
      const s = await api("POST", "/api/pages/delete-many", { pages });
      closePages();
      afterPagesChanged(s, `Deleted ${s.removed} page${s.removed === 1 ? "" : "s"}`);
    }
  } catch (e) {
    pgMsg(e.message, "err");
  } finally {
    $("#pg-go").disabled = false;
  }
}
$("#pg-go").addEventListener("click", runPages);
$("#pg-cancel").addEventListener("click", closePages);
$("#pg-close").addEventListener("click", closePages);
pagesModal.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") { ev.preventDefault(); closePages(); }
  else if (ev.key === "Enter" && !(ev.target instanceof HTMLTextAreaElement)) { ev.preventDefault(); runPages(); }
});

// dropping files while a document is open: ask
const dropModal = $("#dropmodal");
let dropped = [];
function askDrop(files) {
  dropped = files;
  $("#drop-name").textContent = files.length === 1 ? files[0].name : `${files.length} files`;
  $("#drop-open").disabled = files.length !== 1 || !/\.pdf$/i.test(files[0].name);
  dropModal.hidden = false;
}
async function insertDropped(at) {
  dropModal.hidden = true;
  let pos = at;
  let total = 0;
  for (const f of dropped) {
    const s = await guarded(() =>
      api("POST", `/api/pages/insert-upload?at=${pos}`, undefined, { body: f, headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(f.name) } }),
    );
    if (!s) break;
    pos += s.inserted;
    total += s.inserted;
    afterPagesChanged(s, `Inserted ${total} page${total === 1 ? "" : "s"}`);
  }
  dropped = [];
}
$("#drop-open").addEventListener("click", () => { dropModal.hidden = true; uploadFile(dropped[0]); dropped = []; });
$("#drop-after").addEventListener("click", () => insertDropped(st.page + 1));
$("#drop-end").addEventListener("click", () => insertDropped(st.doc.pageCount));
$("#drop-close").addEventListener("click", () => { dropModal.hidden = true; dropped = []; });

// ---------- comments panel ----------

const cm = { items: null, open: false, author: "", filter: "", thisPage: false, replyTo: null };
const cmPanel = $("#comments");
const CM_KIND = { cloud: "Revision cloud", callout: "Callout", polygon: "Polygon", polyline: "Polyline", highlight: "Highlight", underline: "Underline", strikeout: "Strikeout", note: "Note", text: "Text", pen: "Pen", line: "Line", arrow: "Arrow", box: "Box", stamp: "Stamp" };

async function loadAuthor() {
  try {
    const s = await api("GET", "/api/settings");
    cm.author = s.author || "";
  } catch {
    cm.author = "";
  }
  $("#cm-author").textContent = cm.author || "(no name)";
}
loadAuthor();

async function changeAuthor() {
  const name = prompt("Your name, as it should appear on comments:", cm.author);
  if (name === null) return;
  try {
    const s = await api("POST", "/api/settings", { author: name });
    cm.author = s.author;
    $("#cm-author").textContent = cm.author || "(no name)";
    status(`Comments will be signed ${cm.author}`);
  } catch (e) {
    status(e.message, true);
  }
}
$("#cm-author").addEventListener("click", changeAuthor);

function toggleComments(force) {
  cm.open = force ?? !cm.open;
  cmPanel.hidden = !cm.open;
  if (cm.open) refreshComments();
  if (st.doc) layoutPage();
}
$("#btn-comments").addEventListener("click", () => toggleComments());
$("#cm-close").addEventListener("click", () => toggleComments(false));

async function refreshComments() {
  if (!st.doc) { cm.items = []; renderComments(); return; }
  if (!cm.open) { cm.items = null; return; }
  try {
    cm.items = await api("GET", "/api/annots/all");
  } catch (e) {
    cm.items = [];
    status(e.message, true);
  }
  renderComments();
}

function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function cmColor(a) {
  const c = a.color;
  if (Array.isArray(c) && c.length === 3) return `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
  return "var(--line)";
}

function renderComments() {
  if (!cm.open) return;
  const list = $("#cm-list");
  list.textContent = "";
  if (cm.items === null) { refreshComments(); return; }
  const q = cm.filter.trim().toLowerCase();
  const items = cm.items.filter((a) => (!cm.thisPage || a.page === st.page) && (!q || [a.contents, a.stamp, a.author, CM_KIND[a.kind], ...(a.replies || []).map((r) => r.contents + " " + r.author)].join(" ").toLowerCase().includes(q)));
  $("#cm-count").textContent = `${items.length}${items.length !== cm.items.length ? ` / ${cm.items.length}` : ""}`;
  if (!items.length) {
    const e = document.createElement("div");
    e.className = "cm-empty";
    e.textContent = cm.items.length ? "No comments match" : "No comments yet";
    list.append(e);
    return;
  }
  for (const a of items) {
    const card = document.createElement("div");
    card.className = "cm" + (a.id === st.selected ? " active" : "");
    card.style.setProperty("--c", cmColor(a));
    card.dataset.id = a.id;
    const top = document.createElement("div");
    top.className = "cm-top";
    top.innerHTML = `<span class="k"></span><span class="au"></span><span class="dt"></span><span class="pg"></span>`;
    top.querySelector(".k").textContent = CM_KIND[a.kind] || a.kind;
    top.querySelector(".au").textContent = a.author || "";
    top.querySelector(".dt").textContent = fmtWhen(a.modified || a.created);
    top.querySelector(".pg").textContent = `p.${a.page + 1}`;
    const body = document.createElement("div");
    const text = a.stamp ? a.stamp : a.contents;
    body.className = "cm-body" + (text ? "" : " empty");
    body.textContent = text || "(no text)";
    card.append(top, body);
    if (a.replies?.length) {
      const rs = document.createElement("div");
      rs.className = "cm-replies";
      for (const r of a.replies) {
        const rc = document.createElement("div");
        rc.className = "cm-reply";
        rc.innerHTML = `<div class="cm-top"><span class="au"></span><span class="dt"></span></div><div class="cm-body"></div>`;
        rc.querySelector(".au").textContent = r.author || "";
        rc.querySelector(".dt").textContent = fmtWhen(r.modified || r.created);
        rc.querySelector(".cm-body").textContent = r.contents;
        rs.append(rc);
      }
      card.append(rs);
    }
    const acts = document.createElement("div");
    acts.className = "cm-actions";
    const reply = document.createElement("button"); reply.textContent = "Reply";
    const edit = document.createElement("button"); edit.textContent = "Edit"; edit.hidden = !!a.stamp;
    const del = document.createElement("button"); del.textContent = "Delete";
    acts.append(reply, edit, del);
    card.append(acts);
    if (cm.replyTo === a.id) {
      const box = document.createElement("div");
      box.className = "cm-reply-box";
      const ta = document.createElement("textarea");
      ta.placeholder = "Reply… (Ctrl+Enter to post)";
      const ok = document.createElement("button"); ok.textContent = "Post"; ok.className = "primary";
      const post = async () => {
        const t = ta.value.trim();
        if (!t) return;
        await guarded(async () => {
          await api("POST", `/api/annots/${a.id}/reply`, { contents: t });
          cm.replyTo = null;
          await afterAnnotChange();
          status("Reply added");
        });
      };
      ok.onclick = (ev) => { ev.stopPropagation(); post(); };
      ta.onkeydown = (ev) => { if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); post(); } if (ev.key === "Escape") { cm.replyTo = null; renderComments(); } };
      ta.onclick = (ev) => ev.stopPropagation();
      box.append(ta, ok);
      card.append(box);
      setTimeout(() => ta.focus(), 0);
    }
    card.addEventListener("click", () => {
      if (a.page !== st.page) gotoPage(a.page);
      st.selected = a.id;
      drawOverlay();
      $$(".cm").forEach((c) => c.classList.toggle("active", Number(c.dataset.id) === a.id));
      const z = st.zoom;
      const y = a.rect[1] * z;
      if (y < viewer.scrollTop + 20 || y > viewer.scrollTop + viewer.clientHeight - 20) viewer.scrollTop = Math.max(0, y - viewer.clientHeight / 3);
    });
    reply.onclick = (ev) => { ev.stopPropagation(); cm.replyTo = cm.replyTo === a.id ? null : a.id; renderComments(); };
    edit.onclick = (ev) => {
      ev.stopPropagation();
      const t = prompt("Comment text:", a.contents);
      if (t === null || t === a.contents) return;
      guarded(async () => { await api("PATCH", `/api/annots/${a.id}`, { contents: t }); await afterAnnotChange(); });
    };
    del.onclick = (ev) => {
      ev.stopPropagation();
      guarded(async () => { await api("DELETE", `/api/annots/${a.id}`); if (st.selected === a.id) st.selected = null; await afterAnnotChange(); status("Deleted comment"); });
    };
    list.append(card);
  }
}

$("#cm-filter").addEventListener("input", () => { cm.filter = $("#cm-filter").value; renderComments(); });
$("#cm-thispage").addEventListener("change", () => { cm.thisPage = $("#cm-thispage").checked; renderComments(); });

async function exportComments(format) {
  if (!st.doc) return;
  const base = (st.doc.name || "document").replace(/\.pdf$/i, "");
  try {
    const r = await api("POST", "/api/pick", { mode: "save-any", suggest: `${base} comments.${format}` });
    if (!r.path) return;
    const s = await api("POST", "/api/annots/export", { format, path: r.path });
    status(`Saved ${s.path.replace(/^.*\//, "")}`);
  } catch (e) {
    if (e.status === 501) window.open(`/api/annots/summary.${format}`, "_blank");
    else status(e.message, true);
  }
}
$("#cm-export-csv").addEventListener("click", () => exportComments("csv"));
$("#cm-export-pdf").addEventListener("click", () => exportComments("pdf"));

// ---------- polygon / polyline / cloud ----------

function finishVertices() {
  const tool = st.tool;
  const points = st.vertices.slice();
  // The last 2-3 points may be the duplicate clicks of the finish gesture.
  while (points.length >= 2 && Math.hypot(points.at(-1)[0] - points.at(-2)[0], points.at(-1)[1] - points.at(-2)[1]) < 6) points.pop();
  st.vertices = [];
  drawOverlay();
  const min = tool === "polyline" ? 2 : 3;
  if (points.length < min) { status(`${tool} needs at least ${min} points`, true); return; }
  const kind = tool === "cloud" ? "cloud" : tool;
  commit({ tool: kind, points });
}

// ---------- dynamic / custom stamps ----------

const stampState = { items: [], imageFile: null };
async function loadCustomStamps() {
  try {
    const r = await api("GET", "/api/stamps");
    stampState.items = r.stamps || [];
    stampState.author = r.author || "";
  } catch { stampState.items = []; }
  renderCustomStamps();
}
loadCustomStamps();

function resolveStamp(label) {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const time = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return label.replace(/\{date\}/gi, date).replace(/\{time\}/gi, time).replace(/\{author\}/gi, stampState.author || cm.author || "");
}

function renderCustomStamps() {
  const box = $("#custom-stamps");
  box.textContent = "";
  for (const item of stampState.items) {
    const row = document.createElement("div");
    row.className = "stamp custom" + (st.customStamp?.id === item.id ? " active" : "");
    row.title = item.dynamic ? "Dynamic stamp: date/time/author fill in when placed" : "Click to place";
    const label = document.createElement("span"); label.textContent = item.label;
    const rm = document.createElement("button"); rm.className = "rm"; rm.textContent = "×"; rm.title = "Remove from stamp list";
    rm.onclick = async (ev) => {
      ev.stopPropagation();
      await guarded(() => api("DELETE", `/api/stamps/${item.id}`));
      if (st.customStamp?.id === item.id) st.customStamp = null;
      loadCustomStamps();
    };
    row.onclick = () => {
      st.customStamp = item;
      $$("#stamps .stamp[data-stamp]").forEach((b) => b.classList.remove("active"));
      renderCustomStamps();
      setTool("stamp");
      status(`Click to place: ${resolveStamp(item.label)}`);
    };
    row.append(label, rm);
    box.append(row);
  }
}

$("#stamp-add").addEventListener("click", async (ev) => {
  ev.stopPropagation();
  const label = prompt("Stamp text. Use {date}, {time}, {author} for values filled when placed:", "RECEIVED {date} — {author}");
  if (!label?.trim()) return;
  try {
    const item = await api("POST", "/api/stamps", { label: label.trim(), dynamic: /\{date\}|\{time\}|\{author\}/i.test(label) });
    stampState.items.push(item);
    st.customStamp = item;
    $$("#stamps .stamp[data-stamp]").forEach((b) => b.classList.remove("active"));
    renderCustomStamps();
    status("Click the page to place the stamp");
  } catch (e) { status(e.message, true); }
});

const stampFileInput = document.createElement("input");
stampFileInput.type = "file";
stampFileInput.accept = "image/*";
stampFileInput.hidden = true;
document.body.append(stampFileInput);
$("#stamp-image").addEventListener("click", (ev) => { ev.stopPropagation(); stampFileInput.click(); });
stampFileInput.addEventListener("change", () => {
  const f = stampFileInput.files?.[0];
  if (!f) return;
  stampState.imageFile = f;
  st.customStamp = null;
  status(`Click and drag on the page to place ${f.name}`);
  setTool("stamp");
});

async function commitImageStamp(rect) {
  const f = stampState.imageFile;
  if (!f) return;
  const u = new URL("/api/annots/image-stamp", location.origin);
  u.searchParams.set("page", st.page);
  u.searchParams.set("zoom", st.zoom);
  u.searchParams.set("rect", rect.join(","));
  u.searchParams.set("label", f.name);
  await guarded(async () => {
    await api("POST", u.pathname + u.search, undefined, { body: f, headers: { "Content-Type": f.type || "application/octet-stream" } });
    await afterAnnotChange();
    status(`Added ${f.name} image stamp`);
  });
  stampState.imageFile = null;
  stampFileInput.value = "";
}

// ---------- measurement ----------

function fmt(points) {
  return formatDistance(points, st.scale);
}

async function loadScale() {
  if (!st.doc) return;
  try {
    const r = await api("GET", `/api/scale?page=${st.page}`);
    st.scale = { ptPerUnit: r.ptPerUnit, unit: r.unit };
  } catch { st.scale = { ptPerUnit: 1, unit: "in" }; }
  renderScale();
}

function renderScale() {
  const el = $("#m-scale");
  if (!el) return;
  const has = !(st.scale.ptPerUnit === 1 && st.scale.unit === "in");
  el.textContent = has ? `Scale: 1 ${st.scale.unit} = ${trimUnit(st.scale.ptPerUnit)} pt` : "No scale set";
  const sel = $("#m-preset");
  if (sel) {
    const match = findPreset(st.scale.ptPerUnit, st.scale.unit);
    if (match) { sel.value = match; }
    else if (has) {
      sel.value = "__custom__";
      if (!sel.querySelector('option[value="__custom__"]')) {
        const o = document.createElement("option");
        o.value = "__custom__"; o.textContent = "Custom…";
        sel.appendChild(o);
      }
    } else sel.value = "";
  }
}
function findPreset(ptPerUnit, unit) {
  const opts = [...$("#m-preset").options];
  if (unit === "in") return "";
  for (const o of opts) {
    if (!o.value || o.value === "__custom__") continue;
    const p = parsePreset(o.value);
    if (p && Math.abs(p.ptPerUnit - ptPerUnit) < 1e-4 && p.unit === unit) return o.value;
  }
  return "";
}

function trimUnit(v) {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
}

async function setScaleFrom(points, realValue, unit) {
  // points = page points measured on screen; realValue in `unit`
  return setScaleNow(points / realValue, unit);
}

async function setScaleNow(ptPerUnit, unit) {
  await guarded(async () => {
    const r = await api("POST", "/api/scale", { page: st.page, ptPerUnit, unit });
    st.scale = { ptPerUnit: r.ptPerUnit, unit: r.unit };
    renderScale();
    st.rev++;
    setDirty(true);
    status(`Scale set: 1 ${r.unit} = ${trimUnit(r.ptPerUnit)} pt`);
  });
}

const PT_PER_MM = 72 / 25.4;
function parsePreset(v) {
  // "inch:12" => ptPerUnit = 12*inchPerFoot, unit ft; "1:100m" => 283.46 pt/mm
  if (!v) return null;
  const metric = v.endsWith("m");
  const [a, b] = v.replace(/m$/, "").split(":").map(Number);
  if (metric) return { ptPerUnit: PT_PER_MM * b, unit: "mm" };
  // a = drawing inches, b = real inches (or "x inches = y feet" as a:b)
  // ptPerUnit = drawing points per real foot = 72 * (a / b) * 12
  return { ptPerUnit: 864 * (a / b), unit: "ft" };
}

function parseReal(s) {
  const m = String(s).trim().match(/^([0-9]*\.?[0-9]+)\s*(ft|feet|foot|in|inch|inches|m|cm|mm|yd|')?$/i);
  if (!m) return null;
  const value = parseFloat(m[1]);
  let unit = (m[2] || "").toLowerCase();
  if (unit === "feet" || unit === "foot" || unit === "'") unit = "ft";
  if (unit === "inch" || unit === "inches") unit = "in";
  if (!unit) unit = "ft";
  return { value, unit };
}

function finishArea() {
  const pts = st.measure.points.slice();
  // strip duplicate tail from the double-click
  while (pts.length >= 2 && Math.hypot(pts.at(-1)[0] - pts.at(-2)[0], pts.at(-1)[1] - pts.at(-2)[1]) < 6) pts.pop();
  st.measure.points = [];
  st.measure.live = null;
  drawOverlay();
  if (pts.length < 3) { status("Area needs at least 3 points", true); return; }
  // compute in page points
  const pagePts = pts.map(([x, y]) => [x / st.zoom, y / st.zoom]);
  const area = formatArea(ptArea(pagePts), st.scale);
  const perim = formatDistance(ptPerimeter(pagePts), st.scale);
  commit({ tool: "measure-area", points: pts, contents: `${area} · perimeter ${perim}` });
  status(`${area} · perimeter ${perim}`);
}

function ptArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    s += x0 * y1 - x1 * y0;
  }
  return Math.abs(s) / 2;
}

function ptPerimeter(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    s += Math.hypot(x1 - x0, y1 - y0);
  }
  return s;
}

$("#m-preset").addEventListener("change", (ev) => {
  const v = ev.target.value;
  if (!v || v === "__custom__") return;
  const p = parsePreset(v);
  if (p) setScaleNow(p.ptPerUnit, p.unit);
});
$("#m-distance").addEventListener("click", () => setMeasureMode("distance"));
$("#m-area").addEventListener("click", () => setMeasureMode("area"));
$("#m-calibrate").addEventListener("click", () => setMeasureMode("calibrate"));
function setMeasureMode(mode) {
  st.measure.mode = mode;
  st.measure.points = [];
  st.measure.live = null;
  $$("#measureopt .stamp").forEach((b) => b.classList.toggle("active", b.id === `m-${mode}`));
  drawOverlay();
  status(mode === "distance" ? "Drag to measure a distance" : mode === "area" ? "Click points, double-click to finish area" : "Drag a line of known real-world length");
}


// ---------- measure formatting (mirrors lib/measure.mjs) ----------
function formatDistance(points, { ptPerUnit, unit }) {
  const v = points / ptPerUnit;
  if (unit === "ft" || unit === "feet") return formatFeetInches(v * 12);
  if (unit === "in" || unit === "inch" || unit === "inches") return formatFeetInches(v);
  if (unit === "mm") return `${round1(v)} mm`;
  if (unit === "cm") return `${round1(v)} cm`;
  if (unit === "m") return `${round1(v, 2)} m`;
  if (unit === "yd") return `${round1(v, 2)} yd`;
  return `${round1(v, 2)} ${unit}`;
}
function formatArea(points2, { ptPerUnit, unit }) {
  const v = points2 / (ptPerUnit * ptPerUnit);
  if (unit === "ft" || unit === "feet") return `${round1(v, 1)} ft²`;
  if (unit === "in" || unit === "inch" || unit === "inches") return `${round1(v, 1)} in²`;
  if (unit === "mm") return `${round1(v)} mm²`;
  if (unit === "cm") return `${round1(v, 1)} cm²`;
  if (unit === "m") return `${round1(v, 2)} m²`;
  return `${round1(v, 2)} ${unit}²`;
}
function round1(v, d = 2) { const f = 10 ** d; return Math.round(v * f) / f; }
function formatFeetInches(inches) {
  const total = Math.abs(inches);
  const ft = Math.floor(total / 12);
  let inch = Math.round((total - ft * 12) * 16) / 16;
  if (inch >= 12) return `${(inches < 0 ? "-" : "")}${ft + 1}'`;
  let s = "";
  if (ft > 0) s += `${ft}'`;
  if (inch >= 1 / 16) s += (s ? "-" : "") + `${trimInch(inch)}"`;
  if (!s) s = `0"`;
  return (inches < 0 ? "-" : "") + s;
}
function trimInch(v) {
  if (Math.abs(v - Math.round(v)) < 1e-6) return String(Math.round(v));
  const whole = Math.floor(v), frac = v - whole, d = 16;
  let n = Math.round(frac * d);
  if (n === d) return String(whole + 1);
  const g = gcd1(n, d);
  return whole ? `${whole} ${n / g}/${d / g}` : `${n / g}/${d / g}`;
}
function gcd1(a, b) { return b ? gcd1(b, a % b) : a; }

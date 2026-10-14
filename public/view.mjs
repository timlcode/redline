// Page layout, fit zoom, and bookmark rows. Pure functions shared by the viewer and tests.
// Coordinates are CSS pixels. Page sizes are PDF points.

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
export const PAGE_GAP = 12;
export const PAGE_PAD = 24;

export const DISPLAY_MODES = [
  { id: "single", label: "Single Page" },
  { id: "two", label: "Two Pages" },
  { id: "continuous", label: "Continuous" },
  { id: "continuous-two", label: "Continuous Two Pages" },
];

const MODE_IDS = new Set(DISPLAY_MODES.map((m) => m.id));

export function normalizeMode(mode) {
  return MODE_IDS.has(mode) ? mode : "single";
}

export function isContinuous(mode) {
  return mode === "continuous" || mode === "continuous-two";
}

export function isSpread(mode) {
  return mode === "two" || mode === "continuous-two";
}

export function clampZoom(z, min = ZOOM_MIN, max = ZOOM_MAX) {
  const n = Number(z);
  if (!Number.isFinite(n)) return 1;
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
}

/** First page index of the side-by-side pair that contains `index` (0, 2, 4, …). */
export function spreadStart(index) {
  const i = Math.max(0, index | 0);
  return i - (i % 2);
}

function spreadIndexes(focus, count) {
  const start = spreadStart(focus);
  const out = [];
  if (start < count) out.push(start);
  if (start + 1 < count) out.push(start + 1);
  return out;
}

/**
 * Place pages for a display mode.
 * Non-continuous modes lay out only the focused page or the focused pair.
 * Continuous modes lay out every page, top to bottom, and two-page mode pairs them.
 */
export function layoutDocument(pages, mode, zoom, opt = {}) {
  const list = pages || [];
  const gap = opt.gap ?? PAGE_GAP;
  const pad = opt.pad ?? PAGE_PAD;
  const z = clampZoom(zoom);
  const n = list.length;
  const focus = Math.max(0, Math.min(Math.max(0, n - 1), opt.focus ?? 0));
  const two = isSpread(mode);
  const boxes = [];
  if (!n) return { width: pad * 2, height: pad * 2, pages: boxes, mode: normalizeMode(mode) };

  const placeRow = (indexes, y) => {
    let x = pad;
    let rowH = 0;
    const row = [];
    for (const index of indexes) {
      const src = list[index];
      const w = Math.max(1, src.width) * z;
      const h = Math.max(1, src.height) * z;
      row.push({ index, x, y, w, h });
      x += w + gap;
      rowH = Math.max(rowH, h);
    }
    return { row, width: x - gap + pad, height: rowH };
  };

  if (!isContinuous(mode)) {
    const indexes = two ? spreadIndexes(focus, n) : [focus];
    const placed = placeRow(indexes, pad);
    return {
      width: placed.width,
      height: placed.height + pad * 2,
      pages: placed.row,
      mode: normalizeMode(mode),
    };
  }

  let y = pad;
  let maxW = 0;
  let i = 0;
  while (i < n) {
    const indexes = two ? spreadIndexes(i, n) : [i];
    const placed = placeRow(indexes, y);
    boxes.push(...placed.row);
    maxW = Math.max(maxW, placed.width);
    y += placed.height + gap;
    i += indexes.length;
  }
  return { width: maxW, height: y - gap + pad, pages: boxes, mode: normalizeMode(mode) };
}

/**
 * Zoom that fits the focused page, or the focused pair, to the viewport.
 * `fit` is "width" or "page". Gap and pad are CSS pixels, so they are not scaled.
 */
export function fitZoom({ pages, mode, focus = 0, viewW, viewH, fit = "width", gap = PAGE_GAP, pad = PAGE_PAD, min = ZOOM_MIN, max = ZOOM_MAX } = {}) {
  const list = pages || [];
  const n = list.length;
  if (!n || !(viewW > 0) || !(viewH > 0)) return 1;
  const two = isSpread(mode);
  const indexes = two ? spreadIndexes(focus, n) : [Math.max(0, Math.min(n - 1, focus))];
  const sumW = indexes.reduce((s, i) => s + Math.max(1, list[i].width), 0);
  const maxH = Math.max(...indexes.map((i) => Math.max(1, list[i].height)));
  const gaps = gap * Math.max(0, indexes.length - 1);
  const availW = Math.max(1, viewW - pad * 2 - gaps);
  const availH = Math.max(1, viewH - pad * 2);
  const z = fit === "page" ? Math.min(availW / sumW, availH / maxH) : availW / sumW;
  return clampZoom(z, min, max);
}

/** Page indexes whose boxes intersect the vertical viewport, plus `margin` pixels. */
export function pagesNearView(layout, scrollTop, viewH, margin = 0) {
  const pages = layout?.pages || [];
  if (!pages.length) return [];
  const y0 = scrollTop - margin;
  const y1 = scrollTop + Math.max(0, viewH) + margin;
  const out = [];
  for (const p of pages) {
    if (p.y + p.h > y0 && p.y < y1) out.push(p.index);
  }
  return out;
}

/** Page whose center is closest to the middle of the viewport. */
export function dominantPage(layout, scrollTop, viewH) {
  const pages = layout?.pages || [];
  if (!pages.length) return 0;
  const mid = scrollTop + Math.max(0, viewH) / 2;
  let best = pages[0].index;
  let bestScore = Infinity;
  for (const p of pages) {
    const center = p.y + p.h / 2;
    const hits = p.y < scrollTop + viewH && p.y + p.h > scrollTop;
    const score = Math.abs(center - mid) + (hits ? 0 : 1e9);
    if (score < bestScore) {
      bestScore = score;
      best = p.index;
    }
  }
  return best;
}

/** Scroll offsets that bring a page, and an optional point in page points, into view. */
export function bookmarkScroll(layout, page, point, zoom, viewH = 0) {
  const box = (layout?.pages || []).find((p) => p.index === page);
  if (!box) return null;
  const z = clampZoom(zoom);
  let top = box.y;
  let left = box.x;
  if (point && Number.isFinite(point.y)) top = box.y + point.y * z - Math.min(48, Math.max(0, viewH) * 0.08);
  if (point && Number.isFinite(point.x)) left = box.x + point.x * z - 48;
  return { top: Math.max(0, top), left: Math.max(0, left) };
}

/**
 * Visible bookmark rows. `collapsed` is a Set of row ids (`"0"`, `"0.1"`, …).
 * A row with children is expanded unless its id is in the set.
 */
export function flattenOutline(items, collapsed, depth = 0, path = "") {
  const rows = [];
  const hide = collapsed instanceof Set ? collapsed : new Set(collapsed || []);
  (items || []).forEach((item, i) => {
    const id = path ? `${path}.${i}` : String(i);
    const children = item.children || [];
    const hasKids = children.length > 0;
    const open = hasKids && !hide.has(id);
    rows.push({
      id,
      title: item.title || "Untitled",
      page: Number.isInteger(item.page) ? item.page : -1,
      x: Number.isFinite(item.x) ? item.x : null,
      y: Number.isFinite(item.y) ? item.y : null,
      zoom: Number.isFinite(item.zoom) ? item.zoom : null,
      depth,
      hasKids,
      open,
    });
    if (open) rows.push(...flattenOutline(children, hide, depth + 1, id));
  });
  return rows;
}

export function toggleCollapsed(collapsed, id) {
  const next = new Set(collapsed instanceof Set ? collapsed : collapsed || []);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Nested bookmarks start collapsed unless the PDF marked them open. */
export function initialCollapsed(items, path = "") {
  const set = new Set();
  (items || []).forEach((item, i) => {
    const id = path ? `${path}.${i}` : String(i);
    const children = item.children || [];
    if (children.length && !item.open) set.add(id);
    for (const child of initialCollapsed(children, id)) set.add(child);
  });
  return set;
}

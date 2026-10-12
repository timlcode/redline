// Redline measurement: per-page scale calibration and real-world conversions.
// Scale is stored in the PDF catalog under /RedlineMeasure as { pageIndex: [ptsPerUnit, unit] }.
// Default when nothing is stored: 1 point = 1 inch (real scale = drawing scale).

import * as mupdf from "mupdf";

const KEY = "RedlineMeasure";

function catalog(doc) {
  return doc.getTrailer().get("Root");
}

function scaleDict(doc, create = false) {
  const root = catalog(doc);
  let d = root.get(KEY);
  if ((!d || d.isNull()) && create) {
    d = doc.newDictionary();
    root.put(KEY, d);
  }
  return d && !d.isNull() ? d : null;
}

/** { ptPerUnit, unit } for a page. Default: 1 pt = 1 in. */
export function getScale(doc, page) {
  const d = scaleDict(doc);
  if (d) {
    const e = d.get(String(page));
    if (e && !e.isNull() && e.isArray() && e.length >= 2) {
      return { ptPerUnit: e.get(0).asNumber(), unit: (e.get(1).asName() || e.get(1).asString()) || "in" };
    }
  }
  return { ptPerUnit: 1, unit: "in" };
}

export function setScale(doc, page, ptPerUnit, unit) {
  const d = scaleDict(doc, true);
  const arr = doc.newArray();
  arr.push(Number(ptPerUnit) || 1);
  arr.push(String(unit || "in"));
  d.put(String(page), arr);
  return getScale(doc, page);
}

export function clearScale(doc, page) {
  const d = scaleDict(doc);
  if (d) d.delete(String(page));
  return getScale(doc, page);
}

/** Distance in page points between two page-space points. */
export function ptDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Closed-polygon area (shoelace) in square points; vertices are page-space. */
export function ptArea(verts) {
  const n = verts.length;
  if (n < 3) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = verts[i];
    const [x1, y1] = verts[(i + 1) % n];
    s += x0 * y1 - x1 * y0;
  }
  return Math.abs(s) / 2;
}

export function ptPerimeter(verts) {
  let s = 0;
  for (let i = 0; i < verts.length; i++) s += ptDistance(verts[i], verts[(i + 1) % verts.length]);
  return s;
}

/** Real-world length = page points / pointsPerUnit. */
export function toUnits(points, ptPerUnit) {
  return points / ptPerUnit;
}

const MM_PER_IN = 25.4;
const CM_PER_IN = 2.54;

/** Human label for a length, imperial or metric, in the scale's unit. */
export function formatDistance(points, { ptPerUnit, unit }) {
  const v = toUnits(points, ptPerUnit);
  if (unit === "ft" || unit === "feet") return formatFeetInches(v * 12);
  if (unit === "in" || unit === "inch" || unit === "inches") return formatFeetInches(v);
  if (unit === "mm") return `${round(v)} mm`;
  if (unit === "cm") return `${round(v)} cm`;
  if (unit === "m") return `${round(v, 2)} m`;
  if (unit === "yd") return `${round(v, 2)} yd`;
  return `${round(v, 2)} ${unit}`;
}

export function formatArea(points2, { ptPerUnit, unit }) {
  const v = toUnits(points2, ptPerUnit * ptPerUnit);
  if (unit === "ft" || unit === "feet") return `${round(v, 1)} ft²`;
  if (unit === "in" || unit === "inch" || unit === "inches") return `${round(v, 1)} in²`;
  if (unit === "mm") return `${round(v)} mm²`;
  if (unit === "cm") return `${round(v, 1)} cm²`;
  if (unit === "m") return `${round(v, 2)} m²`;
  return `${round(v, 2)} ${unit}²`;
}

function round(v, d = 2) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

/** 12.5 inches -> `12'-6"` (or `6"` / `14'-3 1/4"`-ish). */
export function formatFeetInches(inches) {
  const total = Math.abs(inches);
  const ft = Math.floor(total / 12);
  let inch = total - ft * 12;
  inch = Math.round(inch * 16) / 16; // to 1/16
  let s = "";
  if (ft > 0) s += `${ft}'`;
  if (inch >= 1 / 16) s += (s ? "-" : "") + `${trimInch(inch)}"`;
  if (!s) s = `0"`;
  if (inch >= 11.9375 && ft === 0) s = `1'`; // 11 15/16 rounds up
  return (inches < 0 ? "-" : "") + s;
}

function trimInch(v) {
  if (Math.abs(v - Math.round(v)) < 1e-6) return String(Math.round(v));
  const whole = Math.floor(v);
  const frac = v - whole;
  const d = 16;
  let n = Math.round(frac * d);
  if (n === d) { n = 0; }
  const g = gcd(n, d);
  const num = n / g, den = d / g;
  return whole ? `${whole} ${num}/${den}` : `${num}/${den}`;
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

// Keep mupdf imported so the module stays a sibling of the rest of the pdf code (no-op).
export const _mupdf = mupdf;

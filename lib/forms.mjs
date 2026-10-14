// AcroForm reading and filling. Widgets are listed on demand; opening a file
// does not walk them. Coordinates in the field records are page space (origin
// top-left of the upright page), the same space annotation rects use.
import * as mupdf from "mupdf";
import { httpError } from "./pdf.mjs";
import { paintImageOnPage } from "./signatures.mjs";

const REQUIRED = mupdf.PDFWidget.FIELD_IS_REQUIRED;

function round(n) {
  return Math.round(n * 100) / 100;
}

function widgetId(w) {
  const n = w.getObject().asIndirect();
  return Number.isInteger(n) ? n : 0;
}

export function fieldType(w) {
  const t = w.getFieldType();
  if (t === "text") return "text";
  if (t === "checkbox") return "checkbox";
  if (t === "radiobutton") return "radio";
  if (t === "combobox") return "dropdown";
  if (t === "listbox") return "list";
  if (t === "signature") return "signature";
  if (t === "button") return "button";
  return "button";
}

function humanize(name) {
  const leaf = String(name || "").split(".").pop().replace(/\[\d+\]/g, "");
  const spaced = leaf.replace(/[_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  if (!spaced) return "Field";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fieldLabel(w) {
  try {
    const tu = w.getObject().get("TU");
    if (tu && !tu.isNull() && tu.isString()) {
      const s = tu.asString().trim();
      if (s) return s;
    }
  } catch {
    /* no tooltip */
  }
  let label = "";
  try { label = (w.getLabel() || "").trim(); } catch { label = ""; }
  const name = w.getName() || "";
  if (label && label !== name) return label;
  return humanize(name);
}

function nameOf(obj) {
  try {
    if (obj && !obj.isNull() && obj.isName()) return obj.asName();
  } catch {
    /* not a name */
  }
  return "";
}

/** Appearance state that means "on" for a checkbox or one radio child. */
export function onState(w) {
  try {
    const ap = w.getObject().get("AP", "N");
    if (ap && !ap.isNull() && ap.isDictionary()) {
      let found = "";
      ap.forEach((_val, key) => {
        if (key !== "Off" && !found) found = String(key);
      });
      if (found) return found;
    }
  } catch {
    /* no appearance yet */
  }
  const v = w.getValue();
  if (v && v !== "Off") return v;
  return "Yes";
}

function checked(w) {
  const as = nameOf(w.getObject().get("AS"));
  if (as) return as !== "Off";
  const v = w.getValue();
  return !!v && v !== "Off";
}

function tabMode(page) {
  try {
    const t = page.getObject().getInheritable("Tabs");
    const name = nameOf(t);
    if (name === "R" || name === "C" || name === "S" || name === "A" || name === "W") return name;
  } catch {
    /* default */
  }
  return "W";
}

function sortWidgets(page, widgets) {
  const mode = tabMode(page);
  const items = widgets.map((w, i) => ({ w, i, r: w.getRect() }));
  if (mode === "R") {
    items.sort((a, b) => a.r[1] - b.r[1] || a.r[0] - b.r[0] || a.i - b.i);
  } else if (mode === "C") {
    items.sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.i - b.i);
  }
  return items.map((x) => x.w);
}

function describe(w, pageIndex, tabIndex) {
  const type = fieldType(w);
  const rect = w.getRect().map(round);
  const flags = w.getFieldFlags();
  const out = {
    id: widgetId(w),
    page: pageIndex,
    tabIndex,
    name: w.getName() || "",
    label: fieldLabel(w),
    type,
    value: w.getValue() || "",
    readOnly: w.isReadOnly(),
    required: (flags & REQUIRED) !== 0,
    multiline: type === "text" && w.isMultiline(),
    password: type === "text" && w.isPassword(),
    maxLen: 0,
    options: [],
    option: "",
    selected: false,
    rect,
    editable: false,
  };
  if (type === "text") {
    try { out.maxLen = w.getMaxLen() || 0; } catch { out.maxLen = 0; }
  }
  if (type === "dropdown" || type === "list") {
    try { out.options = w.getOptions(); } catch { out.options = []; }
  }
  if (type === "checkbox") {
    out.selected = checked(w);
    out.option = onState(w);
    out.value = out.selected ? out.option : "Off";
  }
  if (type === "radio") {
    out.option = onState(w);
    out.selected = checked(w);
    out.value = w.getValue() || "Off";
  }
  out.editable = !out.readOnly && type !== "button";
  out.widget = w;
  return out;
}

/** Fillable and read-only fields in tab order. Push buttons are omitted. */
export function listFields(doc) {
  const fields = [];
  const n = doc.countPages();
  let tab = 0;
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    const widgets = sortWidgets(page, page.getWidgets());
    for (const w of widgets) {
      const type = fieldType(w);
      if (type === "button") continue;
      fields.push(describe(w, i, tab));
      tab += 1;
    }
  }
  return fields;
}

export function publicField(field) {
  if (!field) return null;
  const { widget, ...rest } = field;
  void widget;
  return rest;
}

export function publicFields(fields) {
  return fields.map(publicField);
}

export function findField(doc, id) {
  const want = Number(id);
  if (!Number.isInteger(want) || want <= 0) return null;
  const fields = listFields(doc);
  return fields.find((f) => f.id === want) || null;
}

/** Next editable field id, wrapping around. `direction` is 1 or -1. */
export function nextFieldId(fields, currentId, direction = 1) {
  const order = fields.filter((f) => f.editable);
  if (!order.length) return null;
  const dir = direction < 0 ? -1 : 1;
  const i = order.findIndex((f) => f.id === Number(currentId));
  const start = i < 0 ? (dir > 0 ? -1 : 0) : i;
  const n = order.length;
  return order[(start + dir + n) % n].id;
}

function groupWidgets(doc, name) {
  const out = [];
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    for (const w of doc.loadPage(i).getWidgets()) {
      if (w.isRadioButton() && w.getName() === name) out.push(w);
    }
  }
  return out;
}

function selectRadio(doc, name, exportValue) {
  const group = groupWidgets(doc, name);
  if (!group.length) throw httpError(404, "Field not found");
  const states = group.map((w) => onState(w));
  if (exportValue !== "Off" && !states.includes(exportValue)) {
    throw httpError(400, "That choice is not in the list");
  }
  const parent = group[0].getObject().get("Parent");
  const field = parent && !parent.isNull() ? parent : group[0].getObject();
  field.put("V", exportValue);
  for (const w of group) {
    const on = onState(w);
    w.getObject().put("AS", on === exportValue ? on : "Off");
    w.update();
  }
}

/**
 * Set a text, checkbox, radio, dropdown, or list value.
 * Signature fields take an appearance through applySignatureAppearance.
 */
export function setFieldValue(doc, id, value) {
  const found = findField(doc, id);
  if (!found) throw httpError(404, "Field not found");
  if (found.readOnly) throw httpError(400, "Field is read-only");
  const w = found.widget;
  if (found.type === "text") {
    let text = String(value ?? "");
    if (found.maxLen > 0 && text.length > found.maxLen) throw httpError(400, "Value is longer than the field allows");
    w.setTextValue(text);
    w.update();
    if ((w.getValue() || "") !== text) throw httpError(400, "Could not set the field");
  } else if (found.type === "checkbox") {
    const want = value === true || value === "Yes" || value === "On" || value === 1 || value === "1" || value === found.option;
    if (checked(w) !== want) {
      w.toggle();
      w.update();
      if (checked(w) !== want) throw httpError(400, "Could not set the checkbox");
    }
  } else if (found.type === "radio") {
    const choice = value === true ? found.option : String(value ?? "");
    selectRadio(doc, found.name, choice);
  } else if (found.type === "dropdown" || found.type === "list") {
    const choice = String(value ?? "");
    const display = w.getOptions(false);
    const exported = w.getOptions(true);
    if (!display.includes(choice) && !exported.includes(choice)) throw httpError(400, "That choice is not in the list");
    const rc = w.setChoiceValue(choice);
    w.update();
    if (!rc && w.getValue() !== choice) throw httpError(400, "Could not set the choice");
  } else if (found.type === "signature") {
    throw httpError(400, "Use a signature appearance for a signature field");
  } else {
    throw httpError(400, "This field cannot be filled");
  }
  return publicField(findField(doc, id));
}

function pageRectToUser(page, rect) {
  const m = mupdf.Matrix.invert(page.getTransform());
  const pts = [
    [rect[0], rect[1]],
    [rect[2], rect[1]],
    [rect[0], rect[3]],
    [rect[2], rect[3]],
  ].map(([x, y]) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Put a picture in a signature field. The image is drawn into the page at the
 * field rectangle so it is visible immediately. This is not a certificate
 * signature and does not write a signature dictionary.
 */
export function applySignatureAppearance(doc, id, pngBytes) {
  const found = findField(doc, id);
  if (!found) throw httpError(404, "Field not found");
  if (found.type !== "signature") throw httpError(400, "That field is not a signature field");
  if (found.readOnly) throw httpError(400, "Field is read-only");
  if (!pngBytes || pngBytes.length < 16) throw httpError(400, "Signature image required");
  const page = doc.loadPage(found.page);
  const user = pageRectToUser(page, found.widget.getRect());
  if (!paintImageOnPage(doc, page, user, pngBytes)) throw httpError(400, "Could not draw the signature");
  return publicField(findField(doc, id));
}

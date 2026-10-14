// Synthetic pay-application and lien-waiver PDFs for tests.
// Field layout follows a construction pay app (cover sheet plus continuation
// rows) and a lien waiver. These are not official forms and contain no
// personal or company data.
import * as mupdf from "mupdf";
import { userRectToPage } from "../../lib/pdf.mjs";

function esc(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function ensureForm(doc) {
  const helv = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const bold = doc.addSimpleFont(new mupdf.Font("Helvetica-Bold"));
  const form = doc.addObject({
    Fields: [],
    DA: "(/Helv 9 Tf 0 g)",
    DR: { Font: { Helv: helv } },
  });
  doc.getTrailer().get("Root").put("AcroForm", form);
  return { form, helv, bold };
}

function addPage(doc, helv, bold, box, lines) {
  const res = doc.addObject({ Font: { F1: helv, F2: bold } });
  const body = lines.join("");
  const obj = doc.addPage(box, 0, res, body);
  doc.insertPage(-1, obj);
  const page = doc.loadPage(doc.countPages() - 1);
  page.getObject().put("Tabs", "R");
  return page;
}

function textOp(font, size, x, y, text) {
  return `BT /${font} ${size} Tf 0 0 0 rg 1 0 0 1 ${x} ${y} Tm (${esc(text)}) Tj ET\n`;
}

function rectOp(x, y, w, h) {
  return `q 0.25 0.3 0.55 RG 0.7 w ${x} ${y} ${w} ${h} re S Q\n`;
}

function addText(doc, page, form, name, label, userRect, opts = {}) {
  const w = page.createAnnotation("Widget");
  w.setRect(userRectToPage(page, userRect));
  const o = w.getObject();
  let flags = 0;
  if (opts.multiline) flags |= 1 << 12;
  if (opts.readOnly) flags |= 1;
  o.put("FT", "Tx");
  o.put("T", `(${name})`);
  o.put("TU", `(${label})`);
  o.put("DA", "(/Helv 9 Tf 0 g)");
  o.put("F", 4);
  if (flags) o.put("Ff", flags);
  if (opts.maxLen) o.put("MaxLen", opts.maxLen);
  if (opts.value != null) o.put("V", `(${opts.value})`);
  o.put("MK", { BC: [0.25, 0.3, 0.55], BG: [1, 1, 0.96] });
  form.get("Fields").push(o);
  w.update();
}

function addCheck(doc, page, form, name, label, userRect) {
  const w = page.createAnnotation("Widget");
  w.setRect(userRectToPage(page, userRect));
  const o = w.getObject();
  o.put("FT", "Btn");
  o.put("T", `(${name})`);
  o.put("TU", `(${label})`);
  o.put("V", "Off");
  o.put("AS", "Off");
  o.put("F", 4);
  form.get("Fields").push(o);
  w.update();
}

function addChoice(doc, page, form, name, label, userRect, options) {
  const w = page.createAnnotation("Widget");
  w.setRect(userRectToPage(page, userRect));
  const o = w.getObject();
  o.put("FT", "Ch");
  o.put("Ff", 1 << 17);
  o.put("T", `(${name})`);
  o.put("TU", `(${label})`);
  o.put("DA", "(/Helv 9 Tf 0 g)");
  o.put("Opt", options.map((item) => `(${item})`));
  o.put("V", `(${options[0]})`);
  o.put("F", 4);
  o.put("MK", { BC: [0.25, 0.3, 0.55] });
  form.get("Fields").push(o);
  w.update();
}

function addSig(doc, page, form, name, label, userRect) {
  const w = page.createAnnotation("Widget");
  w.setRect(userRectToPage(page, userRect));
  const o = w.getObject();
  o.put("FT", "Sig");
  o.put("T", `(${name})`);
  o.put("TU", `(${label})`);
  o.put("F", 4);
  form.get("Fields").push(o);
  w.update();
}

function radioOn(doc) {
  return doc.addStream(Buffer.from("q 0 0 0 RG 1 w 1 1 12 12 re S 4 4 6 6 re f Q"), {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 14, 14],
  });
}

function radioOff(doc) {
  return doc.addStream(Buffer.from("q 0 0 0 RG 1 w 1 1 12 12 re S Q"), {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 14, 14],
  });
}

function addRadio(doc, page, form, name, choices) {
  const parent = doc.addObject({ FT: "Btn", T: `(${name})`, Ff: 1 << 15, V: "Off" });
  form.get("Fields").push(parent);
  parent.put("Kids", []);
  for (const choice of choices) {
    const w = page.createAnnotation("Widget");
    w.setRect(userRectToPage(page, choice.rect));
    const o = w.getObject();
    o.put("Parent", parent);
    o.put("AS", "Off");
    o.put("F", 4);
    o.put("TU", `(${choice.label})`);
    o.put("AP", { N: { Off: radioOff(doc), [choice.value]: radioOn(doc) } });
    parent.get("Kids").push(o);
    w.update();
  }
}

function lineRow(y, label) {
  return textOp("F1", 9, 40, y, label);
}

/**
 * Three pages: pay application cover, continuation rows, lien waiver.
 * Returns PDF bytes.
 */
export function buildConstructionForms() {
  const doc = new mupdf.PDFDocument();
  const { form, helv, bold } = ensureForm(doc);
  payApplication(doc, form, helv, bold);
  continuation(doc, form, helv, bold);
  lienWaiver(doc, form, helv, bold);
  return Buffer.from(doc.saveToBuffer("garbage").asUint8Array());
}

function payApplication(doc, form, helv, bold) {
  const lines = [
    textOp("F2", 14, 40, 752, "PAY APPLICATION"),
    textOp("F1", 8, 40, 736, "Synthetic cover sheet for tests. Not an official form."),
  ];
  const rows = [
    ["To owner", 700],
    ["Project", 676],
    ["From contractor", 652],
    ["Via architect", 628],
  ];
  for (const [label, y] of rows) lines.push(lineRow(y, label));
  lines.push(textOp("F1", 9, 40, 604, "Application no"));
  lines.push(textOp("F1", 9, 300, 604, "Period to"));
  lines.push(textOp("F1", 9, 40, 580, "Project no"));
  lines.push(textOp("F1", 9, 300, 580, "Contract date"));
  lines.push(textOp("F1", 9, 40, 556, "Contract for"));
  lines.push(textOp("F1", 9, 40, 532, "Distribution"));
  lines.push(textOp("F1", 8, 168, 532, "Owner"));
  lines.push(textOp("F1", 8, 250, 532, "Architect"));
  lines.push(textOp("F1", 8, 350, 532, "Contractor"));
  const amounts = [
    ["1 Original contract sum", 500],
    ["2 Net change by change orders", 478],
    ["3 Contract sum to date", 456],
    ["4 Total completed and stored", 434],
    ["5 Retainage", 412],
    ["6 Total earned less retainage", 390],
    ["7 Less previous certificates", 368],
    ["8 Current payment due", 346],
    ["9 Balance to finish", 324],
    ["Amount certified", 302],
  ];
  for (const [label, y] of amounts) lines.push(lineRow(y, label));
  lines.push(textOp("F1", 9, 40, 270, "Status"));
  lines.push(textOp("F1", 9, 40, 200, "Contractor signature"));
  lines.push(textOp("F1", 9, 320, 200, "Architect signature"));
  lines.push(textOp("F1", 8, 40, 40, "Form mark"));
  const page = addPage(doc, helv, bold, [0, 0, 612, 792], lines);

  const box = (y) => [170, y - 3, 560, y + 13];
  addText(doc, page, form, "toOwner", "To owner", box(700));
  addText(doc, page, form, "project", "Project", box(676));
  addText(doc, page, form, "fromContractor", "From contractor", box(652));
  addText(doc, page, form, "viaArchitect", "Via architect", box(628));
  addText(doc, page, form, "applicationNo", "Application number", [170, 601, 280, 617], { maxLen: 12 });
  addText(doc, page, form, "periodTo", "Period to", [400, 601, 560, 617]);
  addText(doc, page, form, "projectNo", "Project number", [170, 577, 280, 593]);
  addText(doc, page, form, "contractDate", "Contract date", [400, 577, 560, 593]);
  addText(doc, page, form, "contractFor", "Contract for", box(556));
  addCheck(doc, page, form, "distOwner", "Owner copy", [150, 528, 164, 542]);
  addCheck(doc, page, form, "distArchitect", "Architect copy", [232, 528, 246, 542]);
  addCheck(doc, page, form, "distContractor", "Contractor copy", [332, 528, 346, 542]);
  const amountNames = [
    ["originalContract", "Original contract sum", 500],
    ["netChange", "Net change by change orders", 478],
    ["contractSum", "Contract sum to date", 456],
    ["totalCompleted", "Total completed and stored", 434],
    ["retainage", "Retainage", 412],
    ["totalEarned", "Total earned less retainage", 390],
    ["lessPrevious", "Less previous certificates", 368],
    ["currentDue", "Current payment due", 346],
    ["balanceToFinish", "Balance to finish", 324],
    ["amountCertified", "Amount certified", 302],
  ];
  for (const [name, label, y] of amountNames) addText(doc, page, form, name, label, [300, y - 3, 560, y + 13]);
  addChoice(doc, page, form, "applicationStatus", "Status", [170, 266, 320, 284], ["Draft", "Submitted", "Certified", "Paid"]);
  addSig(doc, page, form, "contractorSign", "Contractor signature", [40, 150, 280, 190]);
  addSig(doc, page, form, "architectSign", "Architect signature", [320, 150, 560, 190]);
  addText(doc, page, form, "formMark", "Form mark", [120, 36, 240, 52], { value: "Synthetic", readOnly: true });
}

function continuation(doc, form, helv, bold) {
  const lines = [
    textOp("F2", 14, 36, 560, "CONTINUATION SHEET"),
    textOp("F1", 8, 36, 544, "Synthetic line items for tests. Not an official form."),
    textOp("F1", 9, 36, 516, "Project"),
    textOp("F1", 9, 420, 516, "Application no"),
  ];
  const heads = ["Item", "Description of work", "Scheduled", "Previous", "This period", "Stored", "Total"];
  const xs = [36, 80, 300, 390, 470, 560, 650];
  heads.forEach((h, i) => lines.push(textOp("F2", 8, xs[i], 486, h)));
  const rowY = [450, 420, 390];
  for (const y of rowY) {
    for (let c = 0; c < xs.length; c++) {
      const w = (xs[c + 1] || 760) - xs[c] - 6;
      lines.push(rectOp(xs[c], y - 4, w, 16));
    }
  }
  const page = addPage(doc, helv, bold, [0, 0, 792, 612], lines);
  addText(doc, page, form, "sheetProject", "Project", [90, 512, 400, 528]);
  addText(doc, page, form, "sheetApplication", "Application number", [520, 512, 640, 528], { maxLen: 12 });
  const keys = ["item", "description", "scheduled", "previous", "thisPeriod", "stored", "total"];
  rowY.forEach((y, row) => {
    keys.forEach((key, c) => {
      const x0 = xs[c] + 1;
      const x1 = (xs[c + 1] || 760) - 7;
      addText(doc, page, form, `line${row + 1}_${key}`, `Line ${row + 1} ${key}`, [x0, y - 2, x1, y + 12]);
    });
  });
}

function lienWaiver(doc, form, helv, bold) {
  const lines = [
    textOp("F2", 14, 40, 752, "LIEN WAIVER"),
    textOp("F1", 8, 40, 736, "Synthetic waiver for tests. Not a legal form."),
    textOp("F1", 9, 40, 700, "Claimant"),
    textOp("F1", 9, 40, 668, "Customer"),
    textOp("F1", 9, 40, 636, "Job"),
    textOp("F1", 9, 40, 580, "Owner"),
    textOp("F1", 9, 40, 548, "Through date"),
    textOp("F1", 9, 300, 548, "Amount"),
    textOp("F1", 9, 40, 516, "Type"),
    textOp("F1", 8, 168, 516, "Conditional"),
    textOp("F1", 8, 300, 516, "Unconditional"),
    textOp("F1", 9, 40, 488, "Scope"),
    textOp("F1", 8, 168, 488, "Progress"),
    textOp("F1", 8, 300, 488, "Final"),
    textOp("F1", 9, 40, 456, "Exceptions"),
    textOp("F1", 9, 40, 360, "Date"),
    textOp("F1", 9, 250, 360, "Title"),
    textOp("F1", 9, 40, 300, "Signature"),
  ];
  const page = addPage(doc, helv, bold, [0, 0, 612, 792], lines);
  const wide = (y, h = 16) => [160, y - 3, 560, y - 3 + h];
  addText(doc, page, form, "claimant", "Claimant", wide(700));
  addText(doc, page, form, "customer", "Customer", wide(668));
  addText(doc, page, form, "job", "Job", [160, 590, 560, 650], { multiline: true });
  addText(doc, page, form, "jobOwner", "Owner", wide(580));
  addText(doc, page, form, "throughDate", "Through date", [160, 544, 280, 560]);
  addText(doc, page, form, "waiverAmount", "Amount", [380, 544, 560, 560]);
  addRadio(doc, page, form, "waiverType", [
    { value: "Conditional", label: "Conditional", rect: [150, 512, 164, 526] },
    { value: "Unconditional", label: "Unconditional", rect: [282, 512, 296, 526] },
  ]);
  addRadio(doc, page, form, "waiverScope", [
    { value: "Progress", label: "Progress", rect: [150, 484, 164, 498] },
    { value: "Final", label: "Final", rect: [282, 484, 296, 498] },
  ]);
  addText(doc, page, form, "exceptions", "Exceptions", [160, 390, 560, 450], { multiline: true });
  addText(doc, page, form, "signedDate", "Date", [160, 356, 240, 372]);
  addText(doc, page, form, "signerTitle", "Title", [320, 356, 560, 372]);
  addSig(doc, page, form, "claimantSign", "Claimant signature", [40, 230, 320, 290]);
}

export const PAY_APP_NAMES = [
  "toOwner", "project", "fromContractor", "viaArchitect", "applicationNo", "periodTo",
  "projectNo", "contractDate", "contractFor", "distOwner", "distArchitect", "distContractor",
  "originalContract", "netChange", "contractSum", "totalCompleted", "retainage", "totalEarned",
  "lessPrevious", "currentDue", "balanceToFinish", "amountCertified", "applicationStatus",
  "contractorSign", "architectSign", "formMark",
];

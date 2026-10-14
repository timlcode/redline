import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import * as mupdf from "mupdf";
import * as P from "../lib/pdf.mjs";
import * as F from "../lib/forms.mjs";
import { buildConstructionForms, PAY_APP_NAMES } from "./fixtures/forms.mjs";
import { createServer } from "../server.mjs";

function docFrom(bytes) {
  return P.openBytes(new Uint8Array(bytes));
}

function byName(fields, name) {
  return fields.filter((f) => f.name === name);
}

function inkIn(png, rect) {
  const [x0, y0, x1, y1] = rect.map((v) => Math.round(v));
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(png.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(png.width, x1); x++) {
      const i = (y * png.width + x) * 4;
      if (png.data[i] < 80) n++;
    }
  }
  return n;
}

test("synthetic pay application, continuation sheet, and lien waiver expose the expected fields", () => {
  const doc = docFrom(buildConstructionForms());
  assert.equal(doc.countPages(), 3);
  const fields = F.listFields(doc);
  const names = fields.map((f) => f.name);
  for (const name of PAY_APP_NAMES) assert.ok(names.includes(name), name);
  assert.equal(byName(fields, "toOwner")[0].type, "text");
  assert.equal(byName(fields, "applicationNo")[0].maxLen, 12);
  assert.equal(byName(fields, "distOwner")[0].type, "checkbox");
  assert.equal(byName(fields, "distOwner")[0].selected, false);
  assert.equal(byName(fields, "applicationStatus")[0].type, "dropdown");
  assert.deepEqual(byName(fields, "applicationStatus")[0].options, ["Draft", "Submitted", "Certified", "Paid"]);
  assert.equal(byName(fields, "contractorSign")[0].type, "signature");
  assert.equal(byName(fields, "formMark")[0].readOnly, true);
  assert.equal(byName(fields, "formMark")[0].value, "Synthetic");
  assert.equal(byName(fields, "job")[0].multiline, true);
  assert.equal(byName(fields, "job")[0].page, 2);
  const types = byName(fields, "waiverType");
  assert.equal(types.length, 2);
  assert.deepEqual(types.map((f) => f.option).sort(), ["Conditional", "Unconditional"]);
  const lines = fields.filter((f) => f.name.startsWith("line1_"));
  assert.equal(lines.length, 7);
  assert.ok(lines.some((f) => f.name === "line1_thisPeriod"));
  // Tab order on the cover sheet starts at the top of the page.
  const cover = fields.filter((f) => f.page === 0);
  assert.equal(cover[0].name, "toOwner");
  assert.ok(cover.findIndex((f) => f.name === "formMark") > cover.findIndex((f) => f.name === "project"));
  const first = F.nextFieldId(fields, null, 1);
  assert.equal(fields.find((f) => f.id === first).name, "toOwner");
  const afterOwner = F.nextFieldId(fields, byName(fields, "toOwner")[0].id, 1);
  assert.equal(fields.find((f) => f.id === afterOwner).name, "project");
  const back = F.nextFieldId(fields, byName(fields, "project")[0].id, -1);
  assert.equal(fields.find((f) => f.id === back).name, "toOwner");
});

test("filled text, checkbox, radio, and dropdown values survive save and reopen", () => {
  const doc = docFrom(buildConstructionForms());
  let fields = F.listFields(doc);
  const set = (name, value) => F.setFieldValue(doc, byName(fields, name)[0].id, value);
  set("project", "North wing");
  set("applicationNo", "12");
  set("originalContract", "1000.00");
  set("currentDue", "250.00");
  set("distOwner", true);
  set("applicationStatus", "Certified");
  const conditional = byName(fields, "waiverType").find((f) => f.option === "Conditional");
  F.setFieldValue(doc, conditional.id, "Conditional");
  const progress = byName(fields, "waiverScope").find((f) => f.option === "Progress");
  F.setFieldValue(doc, progress.id, true);
  set("job", "North wing\nLevel 2");
  set("line1_description", "Concrete");
  set("line1_thisPeriod", "100.00");

  assert.throws(() => set("applicationNo", "1234567890123"), /longer than the field/);
  assert.throws(() => set("formMark", "Other"), /read-only/);
  assert.throws(() => set("applicationStatus", "Maybe"), /not in the list/);

  const re = P.openBytes(new Uint8Array(P.saveBytes(doc)));
  fields = F.listFields(re);
  assert.equal(byName(fields, "project")[0].value, "North wing");
  assert.equal(byName(fields, "applicationNo")[0].value, "12");
  assert.equal(byName(fields, "originalContract")[0].value, "1000.00");
  assert.equal(byName(fields, "currentDue")[0].value, "250.00");
  assert.equal(byName(fields, "distOwner")[0].selected, true);
  assert.equal(byName(fields, "applicationStatus")[0].value, "Certified");
  assert.equal(byName(fields, "waiverType")[0].value, "Conditional");
  assert.equal(byName(fields, "waiverType").find((f) => f.option === "Conditional").selected, true);
  assert.equal(byName(fields, "waiverType").find((f) => f.option === "Unconditional").selected, false);
  assert.equal(byName(fields, "waiverScope").find((f) => f.option === "Progress").selected, true);
  assert.equal(byName(fields, "job")[0].value, "North wing\nLevel 2");
  assert.equal(byName(fields, "line1_description")[0].value, "Concrete");
  assert.equal(byName(fields, "line1_thisPeriod")[0].value, "100.00");

  const page = re.loadPage(0);
  const png = PNG.sync.read(Buffer.from(page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false).asPNG()));
  const project = byName(fields, "project")[0];
  assert.ok(inkIn(png, project.rect) > 20, "filled project name is visible");
  const box = byName(fields, "distOwner")[0];
  assert.ok(inkIn(png, box.rect) > 5, "checked box is visible");
});

test("server fills a pay application and keeps the values", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-forms-"));
  const file = path.join(dir, "pay.pdf");
  fs.writeFileSync(file, buildConstructionForms());
  const server = createServer({ dataDir: path.join(dir, "data"), pickCommand: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { "X-Redline": "1", "Content-Type": "application/json" };
  const post = (p, body) => fetch(`${base}${p}`, { method: "POST", headers: H, body: JSON.stringify(body || {}) });
  try {
    await post("/api/open", { path: file });
    const listed = await (await fetch(`${base}/api/fields`)).json();
    assert.ok(listed.fields.length > 40);
    const project = listed.fields.find((f) => f.name === "project");
    const filled = await (await post(`/api/fields/${project.id}`, { value: "North wing" })).json();
    assert.equal(filled.field.value, "North wing");
    const next = filled.fields.find((f) => f.id === F.nextFieldId(filled.fields, project.id, 1));
    assert.equal(next.name, "fromContractor");
    const saved = await (await post("/api/save", {})).json();
    assert.equal(saved.ok, true);
  } finally {
    server.close();
  }
  const re = P.openBytes(new Uint8Array(fs.readFileSync(file)));
  assert.equal(F.listFields(re).find((f) => f.name === "project").value, "North wing");
});

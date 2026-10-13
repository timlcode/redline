import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "redline-handoff-data-"));
process.env.REDLINE_DATA_DIR = dataRoot;
const S = await import("../lib/send.mjs");
after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "redline-handoff-"));
}

test("sendConfig reports handoff targets and the sender address", () => {
  const cfg = S.sendConfig({
    email: "user@example.com",
    handoff: { dropFolder: "/tmp/drop", endpoint: "https://example.com/in" },
  });
  assert.equal(cfg.handoff.ready, true);
  assert.equal(cfg.handoff.dropFolder, "/tmp/drop");
  assert.equal(cfg.handoff.endpoint, "https://example.com/in");
  assert.equal(cfg.handoff.reason, null);
  assert.equal(String(cfg.email.from).toLowerCase(), "user@example.com");
  const empty = S.sendConfig({ email: "", handoff: { dropFolder: "  ", endpoint: "" } });
  assert.equal(empty.handoff.ready, false);
  assert.match(empty.handoff.reason, /settings\.json/);
  assert.equal(empty.email.from, null);
});

test("handoff copies the PDF into the drop folder without overwriting", async (t) => {
  const tmp = scratch();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, "Sheet 1.pdf");
  const body = Buffer.from("%PDF-1.4 drop");
  fs.writeFileSync(file, body);
  const dir = path.join(tmp, "drop");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "Sheet 1.pdf"), "already there");
  const r = await S.sendHandoff(file, { dropFolder: dir });
  assert.equal(r.ok, true);
  assert.equal(r.via, "handoff");
  assert.equal(r.dropped, path.join(dir, "Sheet 1-1.pdf"));
  assert.equal(fs.readFileSync(path.join(dir, "Sheet 1.pdf"), "utf8"), "already there");
  assert.deepEqual(fs.readFileSync(r.dropped), body);
  await assert.rejects(() => S.sendHandoff(file, { dropFolder: "relative/drop" }), /absolute path/);
});

test("handoff POSTs the PDF to an HTTP endpoint", async (t) => {
  const tmp = scratch();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, "Sheet 1.pdf");
  const body = Buffer.from("%PDF-1.4 post");
  fs.writeFileSync(file, body);
  let got = null;
  let type = null;
  let disp = null;
  let method = null;
  const srv = http.createServer((req, res) => {
    method = req.method;
    type = req.headers["content-type"];
    disp = req.headers["content-disposition"];
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      got = Buffer.concat(chunks);
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => srv.close());
  const r = await S.sendHandoff(file, { endpoint: `http://127.0.0.1:${srv.address().port}/inbound?x=1` });
  assert.equal(r.posted.status, 204);
  assert.equal(method, "POST");
  assert.equal(type, "application/pdf");
  assert.match(disp, /filename="Sheet 1.pdf"/);
  assert.deepEqual(got, body);
});

test("handoff runs every configured target and reports a partial failure", async (t) => {
  const tmp = scratch();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, "plan.pdf");
  fs.writeFileSync(file, Buffer.from("%PDF-1.4 both"));
  const dir = path.join(tmp, "drop");
  let posted = false;
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      posted = true;
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => srv.close());
  const ok = await S.sendHandoff(file, { dropFolder: dir, endpoint: `http://127.0.0.1:${srv.address().port}/in` });
  assert.equal(path.basename(ok.dropped), "plan.pdf");
  assert.equal(ok.posted.status, 204);
  assert.equal(posted, true);
  assert.deepEqual(fs.readFileSync(ok.dropped), fs.readFileSync(file));

  const bad = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => bad.listen(0, "127.0.0.1", resolve));
  t.after(() => bad.close());
  await assert.rejects(
    () => S.sendHandoff(file, { dropFolder: dir, endpoint: `http://127.0.0.1:${bad.address().port}/in` }),
    /returned 500.*copy was saved to/,
  );
  assert.equal(fs.existsSync(path.join(dir, "plan-1.pdf")), true);
});

test("handoff rejects a missing or non-http target", async (t) => {
  const tmp = scratch();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, "x.pdf");
  fs.writeFileSync(file, Buffer.from("%PDF"));
  await assert.rejects(() => S.sendHandoff(file, {}), /settings\.json/);
  await assert.rejects(() => S.sendHandoff(file, { endpoint: "not a url" }), /not a valid URL/);
  await assert.rejects(() => S.sendHandoff(file, { endpoint: "file:///tmp/x.pdf" }), /http or https/);
});

test("handoff reads drop folder and endpoint from settings.json", async (t) => {
  const tmp = scratch();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, "from-settings.pdf");
  fs.writeFileSync(file, Buffer.from("%PDF-1.4 settings"));
  const dir = path.join(tmp, "inbox");
  fs.writeFileSync(
    path.join(dataRoot, "settings.json"),
    JSON.stringify({ email: "user@example.com", handoff: { dropFolder: dir } }),
  );
  t.after(() => fs.rmSync(path.join(dataRoot, "settings.json"), { force: true }));
  const r = await S.sendHandoff(file);
  assert.equal(r.dropped, path.join(dir, "from-settings.pdf"));
  assert.deepEqual(fs.readFileSync(r.dropped), fs.readFileSync(file));
  assert.equal(r.posted, undefined);
});

test("saving the author keeps the handoff settings", async (t) => {
  const dir = scratch();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, "data");
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(
    path.join(data, "settings.json"),
    JSON.stringify({
      author: "Before",
      email: "user@example.com",
      handoff: { dropFolder: "/tmp/keep", endpoint: "http://127.0.0.1:9/in" },
    }),
  );
  const { createServer } = await import("../server.mjs");
  const server = createServer({ dataDir: data, pickCommand: false, autoOcrPages: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/settings`, {
    method: "POST",
    headers: { "X-Redline": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ author: "Ada Reviewer" }),
  });
  assert.equal(res.status, 200);
  const saved = JSON.parse(fs.readFileSync(path.join(data, "settings.json"), "utf8"));
  assert.equal(saved.author, "Ada Reviewer");
  assert.equal(saved.email, "user@example.com");
  assert.deepEqual(saved.handoff, { dropFolder: "/tmp/keep", endpoint: "http://127.0.0.1:9/in" });
});

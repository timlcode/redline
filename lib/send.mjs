// Send the open document out of Redline:
//   email     -> a Thunderbird compose window with the PDF attached
//   handoff   -> copy into a drop folder and/or POST the PDF to an HTTP endpoint
//   localsend -> LocalSend protocol v2 spoken directly (mTLS) on the local network
//
// The drop folder, the endpoint, and the default sender address come from
// settings.json in the app data folder. See settings.example.json.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dgram from "node:dgram";
import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const HOME = os.homedir();

export function dataDir() {
  return process.env.REDLINE_DATA_DIR || path.join(HOME, ".local/share/redline");
}

export function readSettings(dir = dataDir()) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function httpError(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function findBin(name, extra = []) {
  const dirs = [...extra, ...(process.env.PATH || "").split(":"), path.join(HOME, ".local/bin")];
  for (const d of dirs) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

function settingsObject(settings) {
  return settings && typeof settings === "object" ? settings : readSettings();
}

function configuredEmail(settings) {
  const src = settings === undefined ? readSettings() : settings;
  return typeof src?.email === "string" ? src.email.trim() : "";
}

// A handoff target is ready when a drop folder, an endpoint, or both are set.
export function normalizeHandoff(handoff) {
  const src = handoff && typeof handoff === "object" ? handoff : {};
  const dropFolder = typeof src.dropFolder === "string" ? src.dropFolder.trim() : "";
  const endpoint = typeof src.endpoint === "string" ? src.endpoint.trim() : "";
  const ready = !!(dropFolder || endpoint);
  return {
    dropFolder: dropFolder || null,
    endpoint: endpoint || null,
    ready,
    reason: ready ? null : "Set handoff.dropFolder and/or handoff.endpoint in settings.json",
  };
}

// ---------- status ----------

function thunderbirdProfiles() {
  const roots = [path.join(HOME, ".thunderbird"), path.join(HOME, ".config/thunderbird")];
  const out = [];
  for (const r of roots) {
    let ents = [];
    try {
      ents = fs.readdirSync(r, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) if (e.isDirectory() && fs.existsSync(path.join(r, e.name, "prefs.js"))) out.push(path.join(r, e.name));
  }
  return out;
}

// Finds the Thunderbird identity (e.g. "id1") whose address matches `email`.
export function senderIdentity(email) {
  const want = String(email === undefined ? configuredEmail() : email || "")
    .trim()
    .toLowerCase();
  if (!want) return null;
  for (const prof of thunderbirdProfiles()) {
    const prefs = fs.readFileSync(path.join(prof, "prefs.js"), "utf8");
    const re = /user_pref\("mail\.identity\.(id\d+)\.useremail",\s*"([^"]+)"\)/g;
    let m;
    while ((m = re.exec(prefs))) if (m[2].toLowerCase() === want) return { id: m[1], email: m[2], profile: prof };
  }
  return null;
}

export function sendConfig(settings) {
  const src = settingsObject(settings);
  const tb = findBin("thunderbird");
  const email = configuredEmail(src);
  const ident = tb ? senderIdentity(email) : null;
  return {
    email: {
      ready: !!tb,
      accountReady: !!tb && (!email || !!ident),
      from: ident ? ident.email : email || null,
      reason: !tb ? "Thunderbird is not installed" : email && !ident ? `Add ${email} to Thunderbird to send from that address` : null,
    },
    handoff: normalizeHandoff(src.handoff),
    localsend: { ready: true },
  };
}

function launchDetached(cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

export function openMailSetup() {
  const tb = findBin("thunderbird");
  if (!tb) throw httpError(500, "Thunderbird is not installed");
  launchDetached(tb, []);
  return { ok: true };
}

// ---------- email: Thunderbird compose window ----------

const tbQuote = (v) => String(v).replace(/'/g, "\u2019").replace(/[\r\n]+/g, " ");

export async function sendEmail(file, { subject, email } = {}) {
  const tb = findBin("thunderbird");
  if (!tb) throw httpError(409, "Thunderbird is not installed");
  const addr = email === undefined ? configuredEmail() : String(email || "").trim();
  const ident = senderIdentity(addr);
  const parts = [
    `attachment='${tbQuote(new URL(`file://${file}`).href)}'`,
    `subject='${tbQuote(subject || path.basename(file, ".pdf"))}'`,
  ];
  if (ident) parts.push(`from='${tbQuote(ident.email)}'`, `preselectid='${ident.id}'`);
  launchDetached(tb, ["-compose", parts.join(",")]);
  return { ok: true, via: "email", from: ident ? ident.email : null, accountReady: !addr || !!ident };
}

// ---------- handoff: drop folder and/or HTTP POST ----------

function resolveDropFolder(folder) {
  let p = String(folder || "").trim();
  if (p === "~") p = HOME;
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = path.join(HOME, p.slice(2));
  if (!path.isAbsolute(p)) throw httpError(400, "handoff.dropFolder must be an absolute path");
  return p;
}

function uniqueDest(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let dest = path.join(dir, filename);
  let i = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(dir, `${base}-${i}${ext}`);
    i += 1;
  }
  return dest;
}

function copyToDrop(file, folder) {
  const dir = resolveDropFolder(folder);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw httpError(400, `Could not create drop folder: ${e.message}`);
  }
  let st;
  try {
    st = fs.statSync(dir);
  } catch (e) {
    throw httpError(400, `Could not use drop folder: ${e.message}`);
  }
  if (!st.isDirectory()) throw httpError(400, "handoff.dropFolder is not a directory");
  const safe = path.basename(file).replace(/[^\w.\- ()[\]]+/g, "_") || "document.pdf";
  const dest = uniqueDest(dir, safe);
  fs.copyFileSync(file, dest);
  return dest;
}

function postPdf(file, endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw httpError(400, "handoff.endpoint is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw httpError(400, "handoff.endpoint must be an http or https URL");
  }
  const lib = url.protocol === "https:" ? https : http;
  const size = fs.statSync(file).size;
  const filename = path.basename(file).replace(/["\\\r\n]/g, "") || "document.pdf";
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (status, msg) => {
      if (settled) return;
      settled = true;
      reject(httpError(status, msg));
    };
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": size,
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          if (settled) return;
          settled = true;
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode });
          else reject(httpError(502, `Handoff endpoint returned ${res.statusCode}`));
        });
      },
    );
    req.setTimeout(120000, () => {
      req.destroy();
      fail(504, "Handoff endpoint timed out");
    });
    req.on("error", (e) => fail(502, `Handoff endpoint failed: ${e.message}`));
    const stream = fs.createReadStream(file);
    stream.on("error", (e) => {
      req.destroy();
      fail(500, `Could not read the PDF: ${e.message}`);
    });
    stream.pipe(req);
  });
}

export async function sendHandoff(file, handoff) {
  const cfg = normalizeHandoff(handoff === undefined ? readSettings().handoff : handoff);
  if (!cfg.ready) throw httpError(409, cfg.reason);
  const result = { ok: true, via: "handoff" };
  if (cfg.dropFolder) result.dropped = copyToDrop(file, cfg.dropFolder);
  if (cfg.endpoint) {
    try {
      result.posted = await postPdf(file, cfg.endpoint);
    } catch (e) {
      if (result.dropped) throw httpError(e.status || 502, `${e.message} (a copy was saved to ${result.dropped})`);
      throw e;
    }
  }
  return result;
}

// ---------- LocalSend (protocol v2) ----------

const LS_GROUP = "224.0.0.167";
const LS_PORT = 53317;
const LS_DIR = path.join(process.env.REDLINE_DATA_DIR || path.join(HOME, ".local/share/redline"), "localsend");

// LocalSend (1.16+) wants mutual TLS: the client presents a certificate and its
// fingerprint is the SHA-256 of that certificate (DER). Make one once and keep it.
function ensureIdentity() {
  const certFile = path.join(LS_DIR, "cert.pem");
  const keyFile = path.join(LS_DIR, "key.pem");
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    fs.mkdirSync(LS_DIR, { recursive: true, mode: 0o700 });
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    const r = spawnSync("openssl", ["req", "-new", "-x509", "-key", keyFile, "-out", certFile, "-days", "3650", "-subj", "/CN=Redline"], {
      stdio: "ignore",
    });
    if (r.status !== 0 || !fs.existsSync(certFile)) {
      fs.rmSync(keyFile, { force: true });
      return null;
    }
  }
  const cert = fs.readFileSync(certFile);
  const fingerprint = crypto.createHash("sha256").update(new crypto.X509Certificate(cert).raw).digest("hex").toUpperCase();
  return { cert, key: fs.readFileSync(keyFile), fingerprint };
}

let identity;
try {
  identity = ensureIdentity();
} catch {
  identity = null;
}
const LS_FINGERPRINT = identity ? identity.fingerprint : crypto.randomBytes(32).toString("hex");
const insecure = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: false,
  ...(identity ? { cert: identity.cert, key: identity.key } : {}),
});

function lsInfo() {
  return {
    alias: `Redline (${os.hostname()})`,
    version: "2.1",
    deviceModel: "Redline",
    deviceType: "desktop",
    fingerprint: LS_FINGERPRINT,
    port: LS_PORT,
    protocol: "https",
    download: false,
  };
}

// LAN IPv4 only: skip loopback, point-to-point (/32), and CGNAT (100.64.0.0/10).
export function lanInterfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (a.netmask === "255.255.255.255") continue;
      const [o1, o2] = a.address.split(".").map(Number);
      if (o1 === 100 && o2 >= 64 && o2 <= 127) continue;
      out.push({ name, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

function lsRequest(dev, method, pathname, body, { timeout = 4000, raw = false } = {}) {
  const lib = dev.protocol === "http" ? http : https;
  return new Promise((resolve, reject) => {
    const payload = raw ? body : body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = lib.request(
      {
        host: dev.ip,
        port: dev.port || LS_PORT,
        path: pathname,
        method,
        agent: dev.protocol === "http" ? undefined : insecure,
        timeout,
        headers: payload
          ? { "Content-Type": raw ? "application/octet-stream" : "application/json", "Content-Length": payload.length }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {}
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function hostsInSubnet(addr, mask) {
  const toInt = (s) => s.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  const a = toInt(addr);
  const m = toInt(mask);
  const net = a & m;
  const size = (~m >>> 0) + 1;
  if (size > 1024) return []; // only scan /22 or smaller
  const out = [];
  for (let i = 1; i < size - 1; i++) {
    const ip = (net + i) >>> 0;
    if (ip === a) continue;
    out.push([ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join("."));
  }
  return out;
}

function normDevice(info, ip) {
  if (!info || typeof info !== "object" || !info.alias) return null;
  return {
    ip,
    port: Number(info.port) || LS_PORT,
    protocol: info.protocol === "http" ? "http" : "https",
    alias: String(info.alias).slice(0, 80),
    deviceModel: info.deviceModel || null,
    deviceType: info.deviceType || null,
    fingerprint: info.fingerprint || null,
  };
}

export async function discoverLocalSend({ timeoutMs = 3500, scan = true, includeSelf = !!process.env.REDLINE_LS_INCLUDE_SELF } = {}) {
  const ifaces = lanInterfaces();
  const own = new Set(ifaces.map((i) => i.address));
  const found = new Map();
  const add = (d) => {
    if (!d || d.fingerprint === LS_FINGERPRINT) return;
    if (own.has(d.ip) && !includeSelf) return;
    const key = d.fingerprint || d.ip;
    if (!found.has(key)) found.set(key, d);
  };

  // 1) multicast announce; devices answer by multicast when they cannot reach our HTTP port
  const mcast = new Promise((resolve) => {
    let sock;
    try {
      sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    } catch {
      return resolve();
    }
    const finish = () => {
      try {
        sock.close();
      } catch {}
      resolve();
    };
    sock.on("error", finish);
    sock.on("message", (msg, rinfo) => {
      try {
        const info = JSON.parse(msg.toString("utf8"));
        add(normDevice(info, rinfo.address));
      } catch {}
    });
    sock.bind(LS_PORT, () => {
      const msg = Buffer.from(JSON.stringify({ ...lsInfo(), announce: true, announcement: true }));
      for (const i of ifaces) {
        try {
          sock.addMembership(LS_GROUP, i.address);
        } catch {}
        try {
          sock.setMulticastInterface(i.address);
          sock.send(msg, LS_PORT, LS_GROUP);
        } catch {}
      }
      setTimeout(() => {
        for (const i of ifaces) {
          try {
            sock.setMulticastInterface(i.address);
            sock.send(msg, LS_PORT, LS_GROUP);
          } catch {}
        }
      }, 800);
      setTimeout(finish, timeoutMs);
    });
  });

  // 2) HTTP(S) sweep of the local subnet: POST /register returns the device info
  const sweep = (async () => {
    if (!scan) return;
    const targets = [];
    for (const i of ifaces) for (const ip of hostsInSubnet(i.address, i.netmask)) targets.push(ip);
    if (includeSelf) for (const i of ifaces) targets.push(i.address);
    let idx = 0;
    const worker = async () => {
      while (idx < targets.length) {
        const ip = targets[idx++];
        // Only fall back to plain HTTP when something answered but TLS failed.
        for (const protocol of ["https", "http"]) {
          try {
            const r = await lsRequest({ ip, port: LS_PORT, protocol }, "POST", "/api/localsend/v2/register", lsInfo(), {
              timeout: 1200,
            });
            if (r.status === 200 && r.json) add(normDevice({ ...r.json, protocol: r.json.protocol || protocol }, ip));
            break;
          } catch (e) {
            if (/timeout|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET/.test(`${e.message} ${e.code}`)) break;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: 128 }, worker));
  })();

  await Promise.all([mcast, sweep]);
  return [...found.values()].sort((a, b) => a.alias.localeCompare(b.alias));
}

export async function sendLocalSend(file, device, { acceptTimeoutMs = 120000 } = {}) {
  if (!device || typeof device.ip !== "string" || !/^\d{1,3}(\.\d{1,3}){3}$/.test(device.ip)) {
    throw httpError(400, "Pick a LocalSend device");
  }
  const dev = { ip: device.ip, port: Number(device.port) || LS_PORT, protocol: device.protocol === "http" ? "http" : "https" };
  const bytes = fs.readFileSync(file);
  const fileId = crypto.randomBytes(8).toString("hex");
  const prep = await lsRequest(
    dev,
    "POST",
    "/api/localsend/v2/prepare-upload",
    {
      info: lsInfo(),
      files: {
        [fileId]: {
          id: fileId,
          fileName: path.basename(file),
          size: bytes.length,
          fileType: "application/pdf",
          sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        },
      },
    },
    { timeout: acceptTimeoutMs },
  ).catch((e) => {
    throw httpError(504, e.message === "timeout" ? "No answer from the device (not accepted in time)" : `Could not reach device: ${e.message}`);
  });
  if (prep.status === 204) return { ok: true, via: "localsend", to: device.alias || dev.ip, detail: "Device already had it" };
  if (prep.status === 403) throw httpError(403, "Declined on the receiving device");
  if (prep.status === 409) throw httpError(409, "Device is busy with another transfer");
  if (prep.status === 401) throw httpError(401, "Device requires a PIN (turn off PIN in its LocalSend settings)");
  if (prep.status !== 200 || !prep.json?.sessionId) throw httpError(502, `LocalSend prepare failed (${prep.status})`);
  const token = prep.json.files?.[fileId];
  if (!token) throw httpError(502, "LocalSend did not return an upload token");
  const q = new URLSearchParams({ sessionId: prep.json.sessionId, fileId, token }).toString();
  const up = await lsRequest(dev, "POST", `/api/localsend/v2/upload?${q}`, bytes, { raw: true, timeout: 300000 });
  if (up.status !== 200) throw httpError(502, `LocalSend upload failed (${up.status})`);
  return { ok: true, via: "localsend", to: device.alias || dev.ip, bytes: bytes.length };
}

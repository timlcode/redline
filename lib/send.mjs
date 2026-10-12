// Send the open document out of Redline:
//   email     -> a Thunderbird compose window (work account) with the PDF attached
//   macs      -> copy straight to Parker's Mac mini / Bishop's MacBook Pro over SSH (Tailscale)
//   telegram  -> Tim's own Telegram chat via the Hermes bot
//   localsend -> LocalSend protocol v2 spoken directly (mTLS), LAN + the two Macs over Tailscale

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dgram from "node:dgram";
import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const HOME = os.homedir();
const WORK_EMAIL = (process.env.REDLINE_WORK_EMAIL || "timothy.lemoine@waycd.com").toLowerCase();

// Tim's Macs. ssh = Host alias in ~/.ssh/config; ts = Tailscale MagicDNS name.
export const MACS = [
  { id: "parker", label: "Parker", machine: "Mac mini", ssh: "timothys-mac-mini", ts: "timothys-mac-mini" },
  { id: "bishop", label: "Bishop", machine: "MacBook Pro", ssh: "timothys-macbook-pro", ts: "timothys-macbook-pro" },
];

function httpError(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function findBin(name, extra = []) {
  const dirs = [...extra, ...(process.env.PATH || "").split(":"), path.join(HOME, ".local/bin"), path.join(HOME, ".hermes/bin")];
  for (const d of dirs) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

const hermesBin = () =>
  process.env.REDLINE_HERMES_BIN || findBin("hermes", [path.join(HOME, ".hermes/hermes-agent/.hermes/bin")]);

function run(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const t = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(t);
      reject(httpError(500, `${path.basename(cmd)} failed to start: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
  });
}

const lastLine = (s) => (s || "").split("\n").filter(Boolean).pop() || "";

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

// Finds the Thunderbird identity (e.g. "id1") whose address is the work email.
export function workIdentity() {
  for (const prof of thunderbirdProfiles()) {
    const prefs = fs.readFileSync(path.join(prof, "prefs.js"), "utf8");
    const re = /user_pref\("mail\.identity\.(id\d+)\.useremail",\s*"([^"]+)"\)/g;
    let m;
    while ((m = re.exec(prefs))) if (m[2].toLowerCase() === WORK_EMAIL) return { id: m[1], email: m[2], profile: prof };
  }
  return null;
}

export function sendConfig() {
  const tb = findBin("thunderbird");
  const ident = tb ? workIdentity() : null;
  return {
    email: {
      ready: !!tb,
      accountReady: !!ident,
      from: ident ? ident.email : WORK_EMAIL,
      reason: !tb ? "Thunderbird is not installed" : !ident ? `Add ${WORK_EMAIL} to Thunderbird once (it signs in with Microsoft)` : null,
    },
    macs: MACS.map(({ id, label, machine }) => ({ id, label, machine })),
    telegram: { ready: !!hermesBin(), to: "You (Hermes bot chat)", reason: hermesBin() ? null : "hermes not found" },
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

export async function sendEmail(file, { subject } = {}) {
  const tb = findBin("thunderbird");
  if (!tb) throw httpError(409, "Thunderbird is not installed");
  const ident = workIdentity();
  const parts = [
    `attachment='${tbQuote(new URL(`file://${file}`).href)}'`,
    `subject='${tbQuote(subject || path.basename(file, ".pdf"))}'`,
  ];
  if (ident) parts.push(`from='${tbQuote(ident.email)}'`, `preselectid='${ident.id}'`);
  launchDetached(tb, ["-compose", parts.join(",")]);
  return { ok: true, via: "email", from: ident ? ident.email : null, accountReady: !!ident };
}

// ---------- Macs: copy over SSH (Tailscale) ----------

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export async function sendToMac(file, macId) {
  const mac = MACS.find((m) => m.id === macId);
  if (!mac) throw httpError(400, "Pick Parker or Bishop");
  const name = path.basename(file);
  const base = name.replace(/\.pdf$/i, "");
  // Never overwrite: name.pdf, name-1.pdf, ...  Then a macOS notification.
  const remote = [
    "cd ~/Downloads || exit 3",
    `n=${shq(name)}; i=1`,
    `while [ -e "$n" ]; do n=${shq(base)}"-$i.pdf"; i=$((i+1)); done`,
    'cat > "$n" || exit 4',
    'echo "$n"',
    `osascript -e ${shq(`display notification "${name.replace(/["\\]/g, "")} is in Downloads" with title "Redline"`)} >/dev/null 2>&1 || true`,
  ].join("; ");
  const r = await new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", mac.ssh, remote], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(httpError(500, `ssh failed: ${e.message}`)));
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    child.stdin.on("error", () => {});
    fs.createReadStream(file).pipe(child.stdin);
  });
  if (r.code === 255) {
    throw httpError(504, `${mac.label}'s ${mac.machine} is not reachable (asleep or offline?)`);
  }
  if (r.code !== 0) throw httpError(502, `Copy to ${mac.machine} failed: ${lastLine(r.err) || r.code}`);
  return { ok: true, via: "mac", to: `${mac.label} (${mac.machine})`, path: `~/Downloads/${lastLine(r.out)}` };
}

// ---------- telegram ----------

// Where Telegram sends go: REDLINE_TELEGRAM_TARGET, else the Hermes home channel,
// else Tim's DM (first TELEGRAM_ALLOWED_USERS id; a user id doubles as the DM chat id).
function telegramTarget() {
  if (process.env.REDLINE_TELEGRAM_TARGET) return process.env.REDLINE_TELEGRAM_TARGET;
  let env = "";
  try {
    env = fs.readFileSync(path.join(HOME, ".hermes/.env"), "utf8");
  } catch {}
  const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "");
  if (get("TELEGRAM_HOME_CHANNEL")) return "telegram";
  const user = (get("TELEGRAM_ALLOWED_USERS") || "").split(/[,\s]+/).find((s) => /^-?\d+$/.test(s));
  return user ? `telegram:${user}` : "telegram";
}

export async function sendTelegram(file, { caption } = {}) {
  const bin = hermesBin();
  if (!bin) throw httpError(409, "hermes not found; Telegram send unavailable");
  const text = `${String(caption || "").trim()}\nMEDIA:${file}`.trim();
  const r = await run(bin, ["send", "--to", telegramTarget(), "--json", text]);
  let parsed = null;
  try {
    parsed = JSON.parse(r.out);
  } catch {}
  if (r.code !== 0 || (parsed && parsed.success === false) || (parsed && parsed.error)) {
    const why = (parsed && (parsed.error || parsed.message)) || lastLine(r.err) || lastLine(r.out) || r.code;
    throw httpError(502, `Telegram failed: ${why}`);
  }
  return { ok: true, via: "telegram", detail: parsed || lastLine(r.out) };
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

// LAN IPv4 interfaces only: skip loopback, point-to-point VPN (/32) and Tailscale CGNAT.
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

  // 3) Tim's Macs over Tailscale (works on or off the home Wi-Fi)
  const macHits = new Map();
  const macProbe = Promise.all(
    MACS.map(async (m) => {
      const ip = await tailscaleIp(m.ts);
      const info = ip ? await lsRegister(ip) : null;
      macHits.set(m.id, info ? normDevice(info, ip) : { ip, alias: null });
    }),
  );

  await Promise.all([mcast, sweep, macProbe]);
  // Pin the Macs first. Same fingerprint seen on the LAN collapses into the Mac entry.
  const macRows = MACS.map((m) => {
    const hit = macHits.get(m.id) || {};
    const lan = hit.fingerprint ? found.get(hit.fingerprint) : null;
    if (hit.fingerprint) found.delete(hit.fingerprint);
    return {
      ...(lan || hit),
      ip: (lan && lan.ip) || hit.ip || null,
      port: hit.port || LS_PORT,
      protocol: hit.protocol || "https",
      alias: `${m.label} (${m.machine})`,
      lsAlias: hit.alias || null,
      deviceModel: hit.alias ? `LocalSend: ${hit.alias}` : "LocalSend not open; Redline will start it",
      mac: m.id,
      online: !!hit.alias,
    };
  });
  const rest = [...found.values()].sort((a, b) => a.alias.localeCompare(b.alias));
  return [...macRows, ...rest];
}

async function tailscaleIp(host) {
  const r = await run("tailscale", ["ip", "-4", host], 5000).catch(() => null);
  const ip = r && r.code === 0 ? r.out.split("\n")[0].trim() : "";
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null;
}

async function lsRegister(ip, timeout = 2500) {
  for (const protocol of ["https", "http"]) {
    try {
      const r = await lsRequest({ ip, port: LS_PORT, protocol }, "POST", "/api/localsend/v2/register", lsInfo(), { timeout });
      if (r.status === 200 && r.json) return { ...r.json, protocol: r.json.protocol || protocol };
      return null;
    } catch (e) {
      if (/timeout|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET/.test(`${e.message} ${e.code}`)) return null;
    }
  }
  return null;
}

// Start LocalSend on a Mac (hidden, in the background) and wait until it answers.
export async function wakeMacLocalSend(mac) {
  const ip = await tailscaleIp(mac.ts);
  if (!ip) throw httpError(504, `${mac.label}'s ${mac.machine} is offline on Tailscale`);
  let info = await lsRegister(ip);
  if (info) return normDevice(info, ip);
  const r = await run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", mac.ssh, "open -g -a LocalSend"], 20000);
  if (r.code === 255) throw httpError(504, `${mac.label}'s ${mac.machine} is not reachable (asleep or offline?)`);
  if (r.code !== 0) throw httpError(502, `Could not start LocalSend on the ${mac.machine}: ${lastLine(r.err) || r.code}`);
  for (let i = 0; i < 20; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    info = await lsRegister(ip, 1500);
    if (info) return normDevice(info, ip);
  }
  throw httpError(504, `LocalSend did not come up on the ${mac.machine}`);
}

export async function sendLocalSend(file, device, { acceptTimeoutMs = 120000 } = {}) {
  if (device && device.mac) {
    const mac = MACS.find((m) => m.id === device.mac);
    if (!mac) throw httpError(400, "Unknown Mac");
    const live = await wakeMacLocalSend(mac);
    device = { ...live, alias: `${mac.label} (${mac.machine})` };
  }
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

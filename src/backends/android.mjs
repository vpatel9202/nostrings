// Client for the nostrings server on an Android device. The server is a dex
// run over ADB with shell privileges (app_process) that speaks the backend
// protocol as JSON lines on the adb shell's stdin and stdout. One server per
// phone is shared by every session through the phone's broker
// (android-broker.mjs), which owns that adb shell and listens on a Unix
// socket only this user can open; nothing listens on the phone.
import { EventEmitter } from "node:events";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import net from "node:net";
import { authorize, authorizeLocked, isAskFirst } from "../approval.mjs";
import { paths } from "../config.mjs";
import { brokerSocket, runBroker } from "./android-broker.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DEX = path.join(here, "..", "..", "native", "android", "build", "nostrings-server.dex");
export const FIXTURE_APK = path.join(here, "..", "..", "native", "android", "build", "nostrings-fixture.apk");
export const FIXTURE_PACKAGE = "com.nostrings.fixture";
// The same app under a second package name, so two sessions can each open one.
export const FIXTURE_APK2 = path.join(here, "..", "..", "native", "android", "build", "nostrings-fixture2.apk");
export const FIXTURE_PACKAGE2 = "com.nostrings.fixture2";
const REMOTE_DEX = "/data/local/tmp/nostrings-server.dex";
const SERVER_CLASS = "com.nostrings.server.Server";

// Methods that only read the app list or the server's own state.
const UNGATED = new Set(["hello", "ping", "permissions", "listApps", "resolveApp", "resolveIntent", "forget", "cursor", "inspect", "waitEvent", "waitQuiet", "_createDisplay", "_displayTree", "_removeRecents", "_tapDisplay", "_events", "_nodeInfo"]);
// Methods that act. Each checks the window it acts on and the lock screen.
const ACTING = new Set(["activate", "keys", "type", "click", "scroll", "drag", "longPress", "touches", "performAction", "setValue", "focusElement", "selectText"]);

function adbPath() {
  if (process.env.NOSTRINGS_ADB) return process.env.NOSTRINGS_ADB;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (sdk && fs.existsSync(path.join(sdk, "platform-tools", "adb"))) return path.join(sdk, "platform-tools", "adb");
  return "adb";
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function adb(args, options = {}) {
  try {
    const { stdout } = await execFileAsync(adbPath(), args, { timeout: options.timeout ?? 20_000, maxBuffer: 8 << 20 });
    return stdout.replace(/\r/g, "");
  } catch (error) {
    if (error.code === "ENOENT") throw codedError("adb not found. Install Android platform-tools or set NOSTRINGS_ADB.", "permission");
    throw codedError(`adb ${args.join(" ")} failed: ${(error.stderr || error.message).trim()}`, "failed");
  }
}

// Online devices as [{serial, state}].
export async function listDevices() {
  const out = await adb(["devices"]);
  return out
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state)
    .map(([serial, state]) => ({ serial, state }));
}

// Picks the transport for `wanted`: that serial if it is online, else any
// online transport of the same phone (its USB serial and its wireless
// "adb-<serial>-..." entry are one device), else the only device when none
// was named.
export async function resolveSerial(wanted) {
  const online = (await listDevices()).filter((d) => d.state === "device");
  if (!wanted) {
    if (online.length === 0) throw codedError("No Android device is connected. Check `adb devices`.", "not_found");
    const physical = new Map();
    for (const d of online) physical.set(await hardwareSerial(d.serial), d.serial);
    if (physical.size > 1) {
      throw codedError(`More than one Android device is connected; name one: ui.device("${[...physical.keys()].join('") or ui.device("')}")`, "bad_request");
    }
    return [...physical.values()][0];
  }
  if (online.some((d) => d.serial === wanted)) return wanted;
  for (const d of online) if ((await hardwareSerial(d.serial)) === wanted) return d.serial;
  throw codedError(`Android device ${wanted} is not connected. Check \`adb devices\`.`, "not_found");
}

async function hardwareSerial(transport) {
  return (await adb(["-s", transport, "shell", "getprop", "ro.serialno"]).catch(() => transport)).trim() || transport;
}

// Processes that hold the one shell automation connection a phone allows.
const COMPETING = [
  [/^uiautomator$|com\.android\.commands\.uiautomator/, "uiautomator"],
  [/io\.appium\.uiautomator2/, "Appium"],
  [/dev\.mobile\.maestro/, "Maestro"],
  [/com\.github\.uiautomator/, "uiautomator2 (Python)"],
];

// Settings some vendors add that block shell input or installs. Named by
// doctor when a probe fails on a phone from that maker.
export const VENDOR_TOGGLES = [
  [/xiaomi|redmi|poco/i, 'Developer options > "USB debugging (Security settings)" and "Install via USB" (needs a SIM and a Mi account)'],
  [/oppo|oneplus|realme/i, 'Developer options > "Disable permission monitoring"'],
  [/vivo|iqoo/i, 'Developer options > "USB debugging (Security settings)"'],
  [/huawei|honor/i, 'Developer options > "Allow ADB debugging in charge only mode"'],
  [/samsung/i, "Settings > Security and privacy > Auto Blocker off (it blocks USB commands)"],
];

export function vendorToggle(manufacturer) {
  const hit = VENDOR_TOGGLES.find(([re]) => re.test(String(manufacturer ?? "")));
  return hit ? hit[1] : null;
}

// Probes each capability a session needs, without touching the phone's own
// screen: a private display and a tap on it. Returns [level, label, fix]
// triples.
export async function capabilityChecks(backend, serial, { shell = (cmd) => adb(["-s", serial, "shell", cmd]) } = {}) {
  const out = [];
  const info = backend.info ?? {};
  const toggle = vendorToggle(info.manufacturer);
  const fix = (base) => (toggle ? `${base}; on this phone check ${toggle}` : base);
  const link = /^emulator-\d+$/.test(serial) ? "the emulator" : /_adb-tls-connect\._tcp|:\d+$/.test(serial) ? "wireless debugging" : "USB";
  out.push(["info", `${serial}: connected over ${link}`]);
  if (info.hiddenScreen) {
    let display = null;
    try {
      display = (await backend.request("_createDisplay", { flags: 0x1fdcb, width: 720, height: 1280, dpi: 320 })).displayId;
      out.push(["ok", `${serial}: hidden screens (private display ${display})`]);
    } catch (error) {
      out.push(["fail", `${serial}: hidden screens: ${error.message}`, fix("Sessions fall back to the phone's own screen: pass {foreground: true}")]);
    }
    if (display != null) {
      try {
        await backend.request("_tapDisplay", { display, x: 10, y: 10 });
        out.push(["ok", `${serial}: input injection (a tap on the private display)`]);
      } catch (error) {
        out.push(["fail", `${serial}: input injection: ${error.message}`, fix("Taps, keys and typing will fail")]);
      }
    }
  } else {
    out.push(["info", `${serial}: hidden screens need Android 14 (API 34); sessions use the phone's own screen`]);
  }
  const timeout = Number((await shell("settings get system screen_off_timeout").catch(() => "")).trim());
  if (Number.isFinite(timeout) && timeout > 0) out.push(["info", `${serial}: screen sleeps after ${Math.round(timeout / 1000)} s; nostrings keeps it awake (dimmed) while it works and wakes it if asleep`]);
  return out;
}

// `nostrings doctor` checks: [{level: "ok"|"fail"|"warn"|"info", label, fix}].
// A phone with a nostrings server already running is reported, not
// connected to: connecting would stop that session's server.
export async function doctorChecks({ client = "nostrings doctor" } = {}) {
  const out = [];
  const add = (level, label, fix) => out.push({ level, label, fix });
  let version;
  try {
    version = (await adb(["version"])).split("\n")[0].trim();
  } catch (error) {
    add("info", "Android: adb not found (optional)", "Install Android platform-tools, or set NOSTRINGS_ADB");
    return out;
  }
  add("ok", `${version} (${adbPath()})`);
  const built = fs.existsSync(SERVER_DEX);
  const devices = await listDevices();
  // Not built only matters once there is a phone to use it on.
  const usable = devices.some((d) => d.state === "device");
  add(built ? "ok" : usable ? "fail" : "info", built ? "Android server built" : "Android server not built", "Run: npm run build:android (a git checkout; the npm package includes it)");
  if (devices.length === 0) add("info", "No Android device connected (adb devices is empty)");
  const seen = new Set();
  for (const { serial, state } of devices) {
    if (state === "unauthorized") {
      add("fail", `${serial}: not authorized`, "Unlock the phone and accept the USB debugging prompt");
      continue;
    }
    if (state !== "device") {
      add("fail", `${serial}: ${state}`, "Reconnect the cable, or for wireless debugging run: adb connect <ip:port>");
      continue;
    }
    const hardware = await hardwareSerial(serial);
    if (seen.has(hardware)) {
      add("ok", `${serial}: same phone as above`);
      continue;
    }
    seen.add(hardware);
    const ps = await adb(["-s", serial, "shell", "ps", "-A", "-o", "ARGS"]).catch(() => "");
    const lines = ps.split("\n");
    const competing = COMPETING.filter(([re]) => lines.some((l) => re.test(l.trim()))).map(([, name]) => name);
    if (competing.length) {
      add("fail", `${serial}: ${competing.join(", ")} is running and holds the screen reader`, "Stop it first; only one automation tool can read the screen at a time");
      continue;
    }
    if (!built) continue;
    const backend = new AndroidBackend({ serial, client });
    try {
      await backend.connect();
      const info = backend.info;
      add("ok", `${serial}: ${info.manufacturer} ${info.model}, Android ${info.release} (API ${info.sdk}), screen ${info.display.join("x")}`);
      add(info.accessibility ? "ok" : "fail", `${serial}: accessibility connection${info.accessibility ? "" : `: ${info.error ?? "failed"}`}`, "Turn off other automation tools, or reboot the phone");
      if (info.accessibility) for (const check of await capabilityChecks(backend, serial)) add(...check);
    } catch (error) {
      add("fail", `${serial}: nostrings server did not start`, error.message);
    } finally {
      backend.close();
    }
  }
  return out;
}

const BROKER_LOG = path.join(paths.home, "android-broker.log");
const NOTIFICATIONS = "android:notifications"; // the approval key for reading the shade
const APP_FUNCTIONS = "android:appfunctions"; // the approval key for listing app functions
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

// `cmd app_function list-app-functions` prints {package: [{<metadata doc>:
// {functionId: [id], enabledByDefault: [bool], schemaName: [...], ...}}]}.
// Returns [{package, id, enabled, schema}].
export function parseAppFunctions(text) {
  if (/No shell command implementation|Can't find service/i.test(text)) throw codedError("This Android version has no app_function shell command (AppFunctions need Android 16 or later, and the shell command a later build)", "unsupported");
  let data;
  try {
    data = JSON.parse(text.slice(text.indexOf("{")));
  } catch {
    throw codedError(`Unexpected app_function output: ${text.slice(0, 200)}`, "error");
  }
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const out = [];
  for (const [pkg, list] of Object.entries(data)) {
    for (const entry of list ?? []) {
      for (const doc of Object.values(entry ?? {})) {
        const id = one(doc?.functionId);
        if (!id) continue;
        const schema = one(doc.schemaName);
        out.push({ package: pkg, id, enabled: one(doc.enabledByDefault) !== false, ...(schema ? { schema } : {}) });
      }
    }
  }
  return out;
}

// `execute-app-function` prints a JSON document, or an error line.
export function parseAppFunctionResult(raw) {
  const exit = Number(/__exit=(\d+)\s*$/.exec(raw)?.[1] ?? 0);
  const text = raw.replace(/\n?__exit=\d+\s*$/, "").trim();
  const start = text.indexOf("{");
  if (exit !== 0 || start < 0) {
    const message = text.replace(/^(Exception|Error):\s*/, "").slice(0, 400) || "The function returned nothing";
    const code = /Timed out/.test(text) ? "timeout" : /not unlocked/.test(text) ? "locked" : /does not exist|not found|No function|unknown function/i.test(text) ? "not_found" : "app_function_error";
    throw codedError(`App function failed: ${message}`, code);
  }
  try {
    return JSON.parse(text.slice(start));
  } catch {
    throw codedError(`Unexpected app_function output: ${text.slice(0, 300)}`, "error");
  }
}
const CLI = path.join(here, "..", "..", "bin", "nostrings.mjs");

// A short hash of the server dex, so a rebuilt server gets its own broker.
function serverBuild() {
  return createHash("sha1").update(fs.readFileSync(SERVER_DEX)).digest("hex").slice(0, 8);
}

function openSocket(socket) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socket);
    conn.once("connect", () => resolve(conn));
    conn.once("error", reject);
  });
}

function startBroker(transport, hardware) {
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const log = fs.openSync(BROKER_LOG, "a", 0o600);
  const child = spawn(process.execPath, [CLI, "android-broker", transport, hardware], { detached: true, stdio: ["ignore", "ignore", log], env: process.env });
  child.unref();
  fs.closeSync(log);
}

// `nostrings android-broker <transport> <hardware serial>` (started by the first session).
export function runDeviceBroker(transport, hardware) {
  return runBroker({ transport, hardware, build: serverBuild(), adb, adbBin: adbPath(), dex: SERVER_DEX, remoteDex: REMOTE_DEX, serverClass: SERVER_CLASS });
}

export class AndroidBackend extends EventEmitter {
  platform = "android";

  constructor({ serial = null, client = "An agent", prompt } = {}) {
    super();
    this.serial = serial;
    this.client = client;
    this.prompt = prompt; // approval dialog; tests replace it
    this.approved = new Set(); // packages approved this session, and lock grants
    this.names = new Map(); // package -> label, for dialogs
    this.transport = null;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.connecting = null;
    this.info = null;
  }

  get label() {
    return this.info?.model ? `${this.info.model} (${this.transport})` : (this.transport ?? this.serial ?? "Android device");
  }

  async connect() {
    if (this.child) return;
    this.connecting ??= this.#connect().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  async #connect() {
    if (!fs.existsSync(SERVER_DEX)) {
      throw codedError("The nostrings Android server is not built. Run: npm run build:android", "not_found");
    }
    const transport = await resolveSerial(this.serial);
    this.transport = transport;
    const socket = brokerSocket(await hardwareSerial(transport), serverBuild());
    // The phone's broker (android-broker.mjs) owns its one server; start it
    // if no session has.
    let conn = await openSocket(socket).catch(() => null);
    if (!conn) {
      startBroker(transport, await hardwareSerial(transport));
      for (let i = 0; i < 150 && !conn; i++) {
        await new Promise((r) => setTimeout(r, 100));
        conn = await openSocket(socket).catch(() => null);
      }
      if (!conn) throw codedError(`The nostrings device broker for ${transport} did not start; see ${BROKER_LOG}`, "failed");
    }
    this.child = conn;
    let buffer = "";
    let exitReason = null;
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("{")) continue;
        try {
          const message = JSON.parse(line);
          if (message.event === "exit") exitReason = message.reason;
          else this.#onMessage(message);
        } catch {
          // A malformed line is noise.
        }
      }
    });
    conn.on("error", () => {});
    conn.on("close", () => {
      if (this.child === conn) this.child = null;
      const reason = exitReason ?? "the connection to the device broker closed";
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(codedError(`The nostrings server on ${this.label} stopped: ${reason}`, "failed"));
      }
      this.pending.clear();
      if (!this.closing) this.emit("exit", { reason });
    });
    this.info = await this.#send("hello", { client: this.client }, 20_000);
  }

  #onMessage(message) {
    if (message.event) {
      this.emit(message.event, message);
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(codedError(message.error.message, message.error.code));
    else waiter.resolve(message.result);
  }

  async request(method, params = {}, { timeout = 30_000 } = {}) {
    if (!this.child) await this.connect();
    if (method === "notifications") {
      // Not one app's: the whole shade, which can hold messages and codes.
      await authorize({
        client: this.client,
        device: this.label,
        approved: this.approved,
        pkg: NOTIFICATIONS,
        name: "the phone's notifications",
        reason: "Notifications can show messages and one-time codes from any app.",
        ...(this.prompt ? { prompt: this.prompt } : {}),
      });
    } else if (!UNGATED.has(method)) await this.#gate(method, params);
    // A cold start on a hidden screen can take tens of seconds on a slow device.
    const result = await this.#send(method, params, method === "activate" ? Math.max(timeout, 60_000) : timeout);
    if (method === "listApps") for (const a of result) this.names.set(a.bundleId, a.name);
    if (method === "resolveApp") this.names.set(result.bundleId, result.name);
    return result;
  }

  // The approval gate (src/approval.mjs): the app, then for actions the
  // package of the window acted on (a payment sheet or permission prompt
  // inside an approved app asks again) and the lock screen.
  async #gate(method, params) {
    const pkg = params.pid;
    if (typeof pkg !== "string" || !pkg) throw codedError(`${method} needs an app (pid)`, "bad_request");
    const common = { client: this.client, device: this.label, approved: this.approved, ...(this.prompt ? { prompt: this.prompt } : {}) };
    const name = this.names.get(pkg);
    await authorize({ ...common, pkg, name });
    if (!ACTING.has(method)) {
      // A hidden screen runs behind the lock screen, so reading it while the
      // phone is locked asks too (once per session, like acting).
      if (params.screen !== "hidden" || this.approved.has(`locked:${this.label}`)) return;
      const info = await this.#send("inspect", { pid: pkg, screen: "hidden", lockOnly: true }, 10_000);
      if (info.locked) await authorizeLocked(common);
      return;
    }
    const point = params.path?.[0] ?? params.paths?.[0]?.[0] ?? (params.x != null ? [params.x, params.y] : null);
    const info = await this.#send(
      "inspect",
      { pid: pkg, screen: params.screen, for: method, ...(point ? { x: point[0], y: point[1] } : {}), ...(Number.isInteger(params.index) ? { index: params.index } : {}) },
      10_000,
    );
    if (info.locked) await authorizeLocked(common);
    const inner = info.windowPackage;
    if (inner && inner !== pkg && isAskFirst(inner)) {
      await authorize({ ...common, pkg: inner, name: info.windowLabel ?? this.names.get(inner), reason: `It is showing inside ${name ?? pkg}.` });
    }
  }

  #send(method, params, timeout) {
    const child = this.child;
    if (!child) throw codedError(`The nostrings server on ${this.label} is not running`, "failed");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(codedError(`${method} timed out after ${timeout} ms on ${this.label}`, "failed"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      child.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  // Copies a file from this computer to the phone (default: Download) and
  // has the media index pick it up, so apps' file and photo pickers show
  // it. Scripts cannot read files otherwise, so each file asks first.
  async push(localPath, { to = "/sdcard/Download/" } = {}) {
    const local = path.resolve(String(localPath));
    let stat;
    try {
      stat = fs.statSync(local);
    } catch {
      throw codedError(`No file at ${local}`, "not_found");
    }
    if (!stat.isFile()) throw codedError(`${local} is not a file`, "bad_request");
    if (!this.child) await this.connect();
    const size = stat.size < 1 << 20 ? `${Math.ceil(stat.size / 1024)} KB` : `${(stat.size / (1 << 20)).toFixed(1)} MB`;
    await authorize({
      client: this.client,
      device: this.label,
      approved: this.approved,
      pkg: `file:${local}`,
      name: path.basename(local),
      reason: `This copies ${local} (${size}) from this computer to the phone, where apps can read it.`,
      ...(this.prompt ? { prompt: this.prompt } : {}),
    });
    const remote = to.endsWith("/") ? `${to}${path.basename(local)}` : to;
    await adb(["-s", this.transport, "push", local, remote], { timeout: 300_000 });
    const quoted = `'${remote.replace(/'/g, "'\\''")}'`;
    await adb(["-s", this.transport, "shell", `content call --uri content://media --method scan_file --arg ${quoted}`]).catch(() => {});
    return { path: remote, bytes: stat.size };
  }

  // AppFunctions (Android 16+ shell command, `cmd app_function`): functions
  // apps publish for agents. Listing asks first once (it shows which apps are
  // installed); calling one asks like opening that app. Both run over adb.
  async appFunctions({ package: pkg } = {}) {
    if (pkg != null && !PACKAGE_NAME.test(pkg)) throw codedError(`Not a package name: ${pkg}`, "bad_request");
    if (!this.child) await this.connect();
    await authorize({
      client: this.client,
      device: this.label,
      approved: this.approved,
      pkg: APP_FUNCTIONS,
      name: "the phone's app functions",
      reason: "This lists the functions apps on the phone offer to agents, which shows which apps are installed.",
      ...(this.prompt ? { prompt: this.prompt } : {}),
    });
    const text = await adb(["-s", this.transport, "shell", `cmd app_function list-app-functions${pkg ? ` --package ${pkg}` : ""}`], { timeout: 60_000 });
    return parseAppFunctions(text);
  }

  async callAppFunction(pkg, id, params = {}, { timeout = 30 } = {}) {
    if (!PACKAGE_NAME.test(String(pkg))) throw codedError(`Not a package name: ${pkg}`, "bad_request");
    if (typeof id !== "string" || !id || id.length > 300) throw codedError("A function id is required", "bad_request");
    if (!this.child) await this.connect();
    await authorize({
      client: this.client,
      device: this.label,
      approved: this.approved,
      pkg,
      name: this.names.get(pkg),
      ...(this.prompt ? { prompt: this.prompt } : {}),
    });
    const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
    const seconds = Math.max(1, Math.min(300, Math.round(Number(timeout) || 30)));
    const cmd = `cmd app_function execute-app-function --package ${pkg} --function ${quote(id)} --parameters ${quote(JSON.stringify(params ?? {}))} --timeout-duration ${seconds}`;
    // The command exits non-zero when the function fails; keep its message.
    const text = (await adb(["-s", this.transport, "shell", `${cmd} 2>&1; echo "__exit=$?"`], { timeout: (seconds + 15) * 1000 })).trim();
    return parseAppFunctionResult(text);
  }

  // Leaves the phone's broker; it closes this session's hidden screens.
  close() {
    const conn = this.child;
    this.child = null;
    this.closing = true;
    if (conn) conn.destroy();
  }
}

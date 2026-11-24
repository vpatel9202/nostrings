// The privileged side of a session. One Broker per runner process: it holds
// the real backends (and so the session's approvals), the action log, saved
// scripts, OCR, screenshots on disk, help text and config, and forwards what
// the runner asks for after checking it.
//
// Everything from the runner is treated as hostile: a cell can take over the
// runner process (node:vm is not a boundary), so the runner's messages may be
// forged. The broker
//   - accepts only known methods per target, with params it rewrites where
//     they reach approval dialogs (prompt text comes from fixed tables or
//     from what the backend resolves, never from the runner);
//   - attributes every request to the cell it is running itself, refuses
//     requests between cells, and after a stop (Escape, a timeout, the user
//     switching away, a device server exiting) refuses every request until
//     the next cell;
//   - writes the action log from the requests it forwards;
//   - writes files only for its own reasons (screenshots in file mode, saved
//     scripts with validated names).
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createBackend, createDeviceBackend } from "./backends/index.mjs";
import { loadConfig, paths } from "./config.mjs";
import { listScripts, readScript, saveScript, scriptsDir, SCRIPT_NAME } from "./scripts.mjs";
import { LOG_LIMIT, scriptLogData } from "./api.mjs";
import { promptOpen } from "./approval.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

// Methods the runner may send to the macOS helper: its dispatch table minus
// `hello`, which names the client in approval dialogs and is the broker's own.
export const HOST_METHODS = new Set([
  "ping", "permissions", "listApps", "resolveApp", "launch", "activate", "isActive", "windows", "otherSpaceWindows",
  "axTree", "menus", "menuPress", "menuShortcut", "selectMenuItem", "windowAction", "appAction", "hover", "gesture",
  "displays", "approveSurface", "elementAtPoint", "allWindows", "screenCapture", "menuExtras", "systemKeys", "clipboard",
  "pasteStash", "open", "dropFiles", "hitTest", "elementFrame", "performAction", "actionNames", "setValue", "selectText",
  "focusElement", "keys", "type", "click", "cursor", "makeKey", "move", "scroll", "drag", "screenshot", "forget",
  "_bringForward",
]);

// Android: any plain method name the server knows (the backend gates every
// one that is not read-only), but not `hello` and not the `_` debug methods,
// which are ungated. `_push` is the broker's own (a file copy that asks).
const DEVICE_METHOD = /^[a-z][A-Za-z]{1,40}$/;
const NOSTRINGS_METHODS = new Set(["ocr", "saveScript", "scriptRun", "scriptLog"]);

// Surfaces the scripting layer asks for by key. The dialog text is here,
// not in the request.
export const SURFACES = {
  "macos:notifications": { name: "your notifications", reason: "Notifications can show messages and one-time codes." },
};

// Reads, not logged (as before the split).
const QUIET = new Set([
  "ping", "permissions", "listApps", "resolveApp", "resolveIntent", "isActive", "windows", "otherSpaceWindows", "axTree",
  "menus", "displays", "elementFrame", "hitTest", "actionNames", "cursor", "forget", "screenshot", "allWindows",
  "menuExtras", "elementAtPoint", "inspect", "waitEvent", "waitQuiet", "move", "makeKey", "approveSurface",
]);

const SYSTEM_KEYS = { screenCapture: "macos:screen", allWindows: "macos:screen", elementAtPoint: "macos:screen", menuExtras: "macos:system", systemKeys: "macos:system", clipboard: "macos:clipboard", dropFiles: "macos:files" };

const SERIAL = /^[A-Za-z0-9._:\-[\]%@]{1,128}$/;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.\-_]{0,254}$/;
const LANGUAGE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,3}$/;
const MAX_DEVICES = 16;
// Captures kept per cell, for out.image and OCR by reference: a few shown
// ones, a few silent ones, and a cap on their total size.
const MAX_IMAGES = 16;
const MAX_SHOWN = 8;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
// Requests a cell may have waiting; the broker runs one at a time.
const MAX_QUEUE = 64;
const KILL_GRACE_MS = 1000;

// Methods that only read: allowed while an approval dialog is open.
let readsCache;
function isRead(method) {
  readsCache ??= new Set([...QUIET].filter((m) => !["move", "makeKey", "approveSurface"].includes(m)));
  return readsCache.has(method);
}

// Helper methods whose approval is that of the app named by `pid` (the
// helper's gate looks the app up from the pid). Passing one is what lets
// `_bringForward` run `open -b` for that app; surface methods such as
// allWindows are approved under their own key and do not count.
const PID_GATED = new Set([
  "activate", "isActive", "windows", "otherSpaceWindows", "axTree", "menus", "menuPress", "menuShortcut", "selectMenuItem",
  "windowAction", "appAction", "hover", "gesture", "pasteStash", "hitTest", "elementFrame", "performAction", "actionNames",
  "setValue", "selectText", "focusElement", "keys", "type", "click", "makeKey", "move", "scroll", "drag", "screenshot",
]);

// Numbers in requests: finite and of sane size; timing and repeat params
// are clamped.
const MAX_NUMBER = 1e7;
const CLAMPS = { count: 3, clickCount: 3, holdMs: 10_000, ms: 10_000, duration: 10_000, durationMs: 10_000, timeout: 60_000, steps: 200, quiet: 10_000, max: 60_000 };

export function checkParams(params, depth = 0) {
  if (depth > 8) throw coded("Refused: params nest too deep", "bad_request");
  if (Array.isArray(params)) {
    if (params.length > 10_000) throw coded("Refused: too many items in a param", "bad_request");
    return params.map((v) => checkParams(v, depth + 1));
  }
  if (typeof params === "number") {
    if (!Number.isFinite(params) || Math.abs(params) > MAX_NUMBER) throw coded("Refused: a number in the request is out of range", "bad_request");
    return params;
  }
  if (!isPlainObject(params)) return params;
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    let v = checkParams(value, depth + 1);
    if (depth === 0 && typeof v === "number" && Object.hasOwn(CLAMPS, key)) {
      if (v < 0) throw coded(`Refused: ${key} cannot be negative`, "bad_request");
      v = Math.min(v, CLAMPS[key]);
    }
    out[key] = v;
  }
  return out;
}

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A compact, redacted copy of a request's params for the action log.
// Methods whose string params carry typed or pasted text.
const TEXT_METHODS = new Set(["type", "setValue", "pasteStash", "systemKeys", "clipboard"]);

export function summarize(method, params, logText) {
  const out = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (key === "pid" || key === "data" || key === "screen" || key === "mode" || key === "windowId") continue;
    const isText = typeof value === "string" && (key === "text" || key === "value" || (TEXT_METHODS.has(method) && key !== "op"));
    if (isText) {
      if (logText) out[key] = value;
      else out[key === "text" || key === "value" ? "length" : `${key}Length`] = value.length;
      continue;
    }
    if (key === "files" && Array.isArray(value)) {
      out.files = value.length;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "string") out[key] = value.length > 300 ? `${value.slice(0, 300)}…` : value;
    else if (value != null) {
      const json = JSON.stringify(value);
      if (json && json.length <= 300) out[key] = value;
      else out[key] = Array.isArray(value) ? `[${value.length} items]` : "[object]";
    }
  }
  return out;
}

export class Broker {
  #runner;
  #client;
  #imageMode;
  #host;
  #devices = new Map();
  #createDevice;
  #cell = null; // {id, title, stopped, images, notes, done}
  #nextCell = 1;
  #chain = Promise.resolve();
  #closed = false;
  #pidBundle = new Map(); // macOS pid -> bundle id, from results the helper returned
  #authorizedPids = new Set(); // pids a gated request passed the helper's approval for
  #onExit;

  #openBundle;

  constructor({ runner, client = "An agent", imageMode = "inline", host, createDevice = (options) => createDeviceBackend(options), onExit, openBundle } = {}) {
    this.#openBundle = openBundle ?? ((bundleId) => execFileAsync("/usr/bin/open", ["-b", bundleId], { timeout: 20_000 }));
    this.#runner = runner;
    this.#client = client;
    this.#imageMode = imageMode;
    this.#createDevice = createDevice;
    this.#onExit = onExit;
    this.isolation = runner.isolation;
    this.#host = host ?? createBackend({ client });
    this.#host.on?.("escape", () => this.#stop("Stopped: the user pressed Escape. Do not continue GUI actions until the user asks.", "escape"));
    runner.lines.on("message", (message) => this.#onMessage(message));
    runner.lines.on("overflow", () => this.#fail("The script runner sent a line over the size limit; it was stopped."));
    runner.child.on("exit", (code, signal) => this.#exited(code, signal));
    this.#send({ op: "init", platform: this.#host.platform ?? null, help: this.#helpText(), scriptsDir: scriptsDir() });
  }

  get closed() {
    return this.#closed;
  }

  #helpText() {
    try {
      return fs.readFileSync(path.join(here, "..", "docs", "api.md"), "utf8");
    } catch {
      return "The API reference (docs/api.md) is missing from this install.";
    }
  }

  #send(message) {
    if (this.#closed) return;
    try {
      this.#runner.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // The runner is gone; exit handling reports it.
    }
  }

  #log(entry) {
    const config = this.#cell?.config ?? safeConfig();
    if (!config?.log?.enabled) return;
    try {
      fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
      // Fixed fields last: nothing in `entry` can overwrite them.
      const line = { ...entry, ts: new Date().toISOString(), client: this.#client, step: this.#cell?.title ?? undefined };
      fs.appendFileSync(paths.log, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch {
      // Logging must never break an action.
    }
  }

  // Runs one cell (already rewritten by transform.mjs) and returns
  // {ok, content}. Cells run one at a time.
  eval(code, { title } = {}) {
    const run = this.#chain.then(() => this.#eval(code, title));
    this.#chain = run.catch(() => {});
    return run;
  }

  async #eval(code, title) {
    if (this.#closed) return { ok: false, content: [{ type: "text", text: this.#exitText ?? "The session process exited; bindings were lost." }] };
    let config;
    try {
      config = loadConfig();
    } catch (error) {
      return { ok: false, content: [{ type: "text", text: error.message }] };
    }
    const id = this.#nextCell++;
    let resolveDone;
    const done = new Promise((resolve) => (resolveDone = resolve));
    this.#cell = { id, title: title || null, config, stopped: null, images: new Map(), imageBytes: 0, dropped: 0, nextImage: 1, notes: [], queue: [], pumping: false, resolve: resolveDone };
    // The runner gets the settings the script layer reads, not the approval
    // lists or mode.
    const { approval, allow, deny, askFirst, daemon, ...forRunner } = config;
    this.#send({ op: "eval", id, code, config: forRunner, scripts: this.#scriptSnapshot() });
    const reply = await done;
    const cell = this.#cell;
    this.#cell = null;
    if (reply.raw) return reply.raw;
    const content = this.#finish(reply.content, cell);
    if (cell.stopped) {
      // Whatever the runner says, a stopped call failed, and says why.
      const last = content.at(-1);
      if (!(last?.type === "text" && last.text.endsWith(cell.stopped))) {
        if (last?.type === "text") last.text += `\n${cell.stopped}`;
        else content.push({ type: "text", text: cell.stopped });
      }
      return { ok: false, content };
    }
    return { ok: reply.ok && !cell.notes.length, content };
  }

  #scriptSnapshot() {
    try {
      return listScripts().map(({ name, description }) => ({ name, description, source: readScript(name) }));
    } catch {
      return [];
    }
  }

  // Validates the runner's content and turns image references into images
  // (or files, for the CLI).
  #finish(content, cell) {
    const out = [];
    const pushText = (text) => {
      if (text === "") return;
      const last = out.at(-1);
      if (last?.type === "text") last.text += `\n${text}`;
      else out.push({ type: "text", text });
    };
    for (const item of Array.isArray(content) ? content.slice(0, 2000) : []) {
      if (!isPlainObject(item)) continue;
      if (item.type === "text" && typeof item.text === "string") pushText(item.text);
      else if (item.type === "image" && typeof item.ref === "string") {
        const image = cell.images.get(item.ref);
        if (!image) continue;
        if (this.#imageMode === "file") pushText(this.#saveImage(image, String(item.label ?? "")));
        else out.push({ type: "image", mimeType: image.mimeType, data: image.data });
      }
    }
    if (cell.dropped) pushText(`(${cell.dropped} earlier image${cell.dropped === 1 ? "" : "s"} from this call not shown: over the per-call limit)`);
    for (const note of cell.notes) pushText(note);
    return out;
  }

  #saveImage(image, label) {
    try {
      fs.mkdirSync(paths.shots, { recursive: true, mode: 0o700 });
      const ext = image.mimeType === "image/jpeg" ? "jpg" : "png";
      const safe = label.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "image";
      const file = path.join(paths.shots, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safe}.${ext}`);
      fs.writeFileSync(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
      return `Image saved: ${file}`;
    } catch (error) {
      return `Could not save the image: ${error.message}`;
    }
  }

  // Stops the running cell: the runner is told, and the broker refuses its
  // requests until the next cell.
  abort(reason) {
    this.#stop(reason, "timeout");
  }

  // `by` says who stopped it: "escape", "timeout", "device", or "runner"
  // (whose reason is the runner's own text, capped and logged as such).
  #stop(reason, by = "host") {
    const cell = this.#cell;
    if (!cell || cell.stopped) return;
    const text = String(reason).slice(0, by === "runner" ? 300 : 500);
    cell.stopped = by === "runner" && !text.startsWith("Stopped") ? `Stopped: ${text}` : text;
    this.#log({ action: "stopped", by, reason: cell.stopped });
    this.#send({ op: "abort", reason: cell.stopped });
    // Requests already queued are refused as they come up.
  }

  #onMessage(message) {
    if (!isPlainObject(message)) return;
    switch (message.op) {
      case "call":
        this.#onCall(message);
        return;
      case "show":
        // out.image fired: keep that capture for the result.
        if (this.#cell && typeof message.ref === "string") {
          const image = this.#cell.images.get(message.ref);
          if (image && !image.shown) {
            image.shown = true;
            this.#trimImages(this.#cell, message.ref);
          }
        }
        return;
      case "stop":
        if (typeof message.reason === "string") this.#stop(message.reason, "runner");
        return;
      case "done":
        if (this.#cell && message.id === this.#cell.id) this.#cell.resolve({ ok: message.ok === true, content: message.content });
        return;
      default:
      // Anything else (a second ready, junk a cell printed) is ignored.
    }
  }

  #reply(rid, body) {
    this.#send({ op: "reply", rid, ...body });
  }

  // Requests run one at a time per cell, in order. A stop refuses the ones
  // still waiting.
  #onCall(message) {
    if (!Number.isSafeInteger(message.rid)) return;
    const cell = this.#cell;
    if (!cell) return this.#refuse(message, coded("Refused: no call is running. nostrings acts only while a js call runs.", "stopped"));
    if (cell.stopped) return this.#refuse(message, coded(cell.stopped, "stopped"));
    if (cell.queue.length >= MAX_QUEUE) return this.#refuse(message, coded(`Refused: more than ${MAX_QUEUE} requests waiting`, "busy"));
    cell.queue.push(message);
    if (!cell.pumping) this.#pump(cell);
  }

  async #pump(cell) {
    cell.pumping = true;
    try {
      while (cell.queue.length) {
        const message = cell.queue.shift();
        await this.#runCall(cell, message);
        // Respect the pipe: wait for the runner to take a reply before the next.
        const stdin = this.#runner.child.stdin;
        if (stdin?.writableNeedDrain && !this.#closed) {
          await new Promise((resolve) => {
            stdin.once("drain", resolve);
            this.#runner.child.once("exit", resolve);
          });
        }
      }
    } finally {
      cell.pumping = false;
    }
  }

  #refuse(message, error) {
    const meta = message.target === "device" ? this.#deviceMeta(message.serial) : undefined;
    this.#reply(message.rid, { error: { message: String(error?.message ?? error), code: typeof error?.code === "string" ? error.code : "failed" }, ...(meta ? { meta } : {}) });
  }

  async #runCall(cell, message) {
    const { rid, target, method } = message;
    try {
      if (this.#cell !== cell) throw coded("Refused: that call has ended.", "stopped");
      if (cell.stopped) throw coded(cell.stopped, "stopped");
      if (typeof method !== "string") throw coded("Refused: the request names no method", "bad_request");
      const params = checkParams(isPlainObject(message.params) ? message.params : {});
      if ((target === "host" || target === "device") && !isRead(method) && promptOpen()) {
        throw coded("Refused: an approval dialog is open; nothing acts until the user answers it.", "busy");
      }
      let result;
      let meta;
      if (target === "host") result = await this.#hostCall(cell, method, params);
      else if (target === "device") ({ result, meta } = await this.#deviceCall(cell, message.serial, method, params));
      else if (target === "nostrings") result = await this.#nostringsCall(cell, method, params);
      else throw coded(`Refused: unknown target ${JSON.stringify(String(target)).slice(0, 40)}`, "bad_request");
      const imageRef = this.#keepImage(cell, result);
      this.#reply(rid, { result: result ?? null, ...(meta ? { meta } : {}), ...(imageRef ? { imageRef } : {}) });
    } catch (error) {
      this.#refuse(message, error);
    }
  }

  // Captures (screenshots) are kept for this cell, so the runner can show
  // or OCR one by reference instead of sending its bytes back.
  #keepImage(cell, result) {
    if (!isPlainObject(result) || typeof result.data !== "string" || !/^image\/(png|jpeg)$/.test(String(result.mimeType))) return null;
    const ref = `img${cell.nextImage++}`;
    cell.images.set(ref, { data: result.data, mimeType: result.mimeType, shown: false });
    cell.imageBytes += result.data.length;
    this.#trimImages(cell);
    return ref;
  }

  // Silent captures (polling, OCR) go first, oldest first; shown ones only
  // past MAX_SHOWN or the byte cap, and the result then says how many.
  #trimImages(cell, keep) {
    const drop = (ref) => {
      const image = cell.images.get(ref);
      cell.images.delete(ref);
      cell.imageBytes -= image.data.length;
      if (image.shown) cell.dropped += 1;
    };
    const over = () => cell.images.size > MAX_IMAGES || cell.imageBytes > MAX_IMAGE_BYTES;
    while (over()) {
      const silent = [...cell.images].find(([ref, image]) => !image.shown && ref !== keep);
      if (!silent) break;
      drop(silent[0]);
    }
    let shown = [...cell.images].filter(([, image]) => image.shown);
    while ((shown.length > MAX_SHOWN || cell.imageBytes > MAX_IMAGE_BYTES) && shown.length) {
      drop(shown.shift()[0]);
    }
  }

  #remember(result) {
    const list = Array.isArray(result) ? result : [result];
    for (const app of list) {
      if (isPlainObject(app) && Number.isInteger(app.pid) && typeof app.bundleId === "string") this.#pidBundle.set(app.pid, app.bundleId);
    }
  }

  #hostApp(method, params) {
    if (SYSTEM_KEYS[method]) return SYSTEM_KEYS[method];
    if (method === "open") return params.bundleId ?? "default";
    if (method === "launch") return params.bundleId;
    if (Number.isInteger(params.pid)) return this.#pidBundle.get(params.pid) ?? `pid:${params.pid}`;
    return undefined;
  }

  async #hostCall(cell, method, raw) {
    if (!HOST_METHODS.has(method)) throw coded(`Refused: ${method.slice(0, 60)} is not a method scripts may call`, "bad_request");
    if (method === "_bringForward") return this.#bringForward(cell, raw);
    const params = await this.#hostParams(method, raw);
    if (!QUIET.has(method)) this.#log({ app: this.#hostApp(method, params), action: method, params: summarize(method, params, cell.config.log?.text) });
    try {
      const result = await this.#host.request(method, params);
      if (["listApps", "resolveApp", "launch", "open"].includes(method)) this.#remember(result);
      if (Number.isInteger(params.pid) && PID_GATED.has(method)) this.#authorizedPids.add(params.pid);
      return result;
    } catch (error) {
      // activate_failed comes after the helper's approval passed.
      if (error?.code === "activate_failed" && Number.isInteger(params.pid)) this.#authorizedPids.add(params.pid);
      throw error;
    }
  }

  // Params the helper puts in approval dialogs come from the broker.
  async #hostParams(method, raw) {
    switch (method) {
      case "permissions":
        return {}; // `ask` fires a macOS privacy prompt; only setup asks
      case "approveSurface": {
        const surface = SURFACES[raw.key];
        if (!surface || !Object.hasOwn(SURFACES, raw.key)) throw coded(`Refused: unknown surface ${String(raw.key).slice(0, 60)}`, "bad_request");
        return { key: raw.key, ...surface };
      }
      case "launch": {
        // The helper approves `bundleId` but launches `path`; take both, and
        // the name, from the helper's own resolution of the bundle id.
        if (typeof raw.bundleId !== "string" || !BUNDLE_ID.test(raw.bundleId)) throw coded("Refused: launch needs a bundle id", "bad_request");
        const info = await this.#host.request("resolveApp", { query: raw.bundleId });
        if (!isPlainObject(info) || typeof info.bundleId !== "string" || info.bundleId.toLowerCase() !== raw.bundleId.toLowerCase()) {
          throw coded(`Refused: ${raw.bundleId} does not resolve to that app`, "bad_request");
        }
        return { bundleId: info.bundleId, ...(typeof info.path === "string" ? { path: info.path } : {}), ...(typeof info.name === "string" ? { name: info.name } : {}), activate: raw.activate === true };
      }
      case "open":
        if (typeof raw.target !== "string" || !raw.target) throw coded("Refused: open needs a path or URL", "bad_request");
        if (raw.bundleId != null && (typeof raw.bundleId !== "string" || !BUNDLE_ID.test(raw.bundleId))) throw coded("Refused: bad bundle id", "bad_request");
        return { target: raw.target, ...(raw.bundleId != null ? { bundleId: raw.bundleId } : {}), activate: raw.activate === true };
      case "clipboard":
        if (!["read", "write", "stash", "restore"].includes(raw.op)) throw coded("Refused: unknown clipboard op", "bad_request");
        return raw;
      default:
        return raw;
    }
  }

  // LaunchServices (`open -b`) brings an app forward when macOS refuses a
  // background app's activation. Only for an app the helper already approved
  // in this session, by the bundle id the helper reported for that pid.
  async #bringForward(cell, raw) {
    const pid = raw.pid;
    if (process.platform !== "darwin" || this.#host.platform !== "macos") throw coded("Refused: bringing forward is for the Mac", "bad_request");
    if (!Number.isInteger(pid) || !this.#authorizedPids.has(pid)) throw coded("Refused: that app was not approved in this session", "denied");
    if (!this.#pidBundle.has(pid)) this.#remember(await this.#host.request("listApps"));
    const bundleId = this.#pidBundle.get(pid);
    if (typeof bundleId !== "string" || !BUNDLE_ID.test(bundleId)) throw coded("Refused: no bundle id for that app", "not_found");
    this.#log({ app: bundleId, action: "bring forward" });
    await this.#openBundle(bundleId);
    return {};
  }

  #device(serial) {
    if (serial != null && (typeof serial !== "string" || !SERIAL.test(serial))) throw coded("Refused: bad device serial", "bad_request");
    const key = serial ?? "";
    let device = this.#devices.get(key);
    if (!device) {
      if (this.#devices.size >= MAX_DEVICES) throw coded("Refused: too many devices in one session", "bad_request");
      device = this.#createDevice({ serial: serial ?? null, client: this.#client });
      device.on?.("escape", () => this.#stop("Stopped: the user asked to stop on the device. Do not continue GUI actions until the user asks.", "device"));
      device.on?.("exit", ({ reason } = {}) => this.#stop(`Stopped: the nostrings server on ${device.label} stopped (${reason}). Do not continue GUI actions on it until the user asks.`, "device"));
      this.#devices.set(key, device);
    }
    return device;
  }

  #deviceMeta(serial) {
    const device = this.#devices.get(serial ?? "");
    if (!device) return undefined;
    return { label: String(device.label ?? ""), info: device.info ? { hiddenScreen: Boolean(device.info.hiddenScreen) } : null };
  }

  async #deviceCall(cell, serial, method, raw) {
    const device = this.#device(serial);
    let result;
    if (method === "_push") {
      if (typeof raw.path !== "string" || !raw.path) throw coded("Refused: push needs a file path", "bad_request");
      if (raw.to != null && typeof raw.to !== "string") throw coded("Refused: bad destination", "bad_request");
      result = await device.push(raw.path, raw.to != null ? { to: raw.to } : {});
      this.#log({ app: "android:files", action: "push", device: device.label, path: result?.path, bytes: result?.bytes });
    } else {
      if (!DEVICE_METHOD.test(method) || method === "hello") throw coded(`Refused: ${method.slice(0, 60)} is not a method scripts may call`, "bad_request");
      if (!QUIET.has(method)) {
        this.#log({ app: method === "notifications" ? "android:notifications" : typeof raw.pid === "string" ? raw.pid.slice(0, 200) : undefined, action: method, device: device.label, params: summarize(method, raw, cell.config.log?.text) });
      }
      result = await device.request(method, raw);
    }
    return { result, meta: this.#deviceMeta(serial) };
  }

  async #nostringsCall(cell, method, raw) {
    if (!NOSTRINGS_METHODS.has(method)) throw coded(`Refused: unknown request ${method.slice(0, 60)}`, "bad_request");
    if (method === "ocr") {
      const image = typeof raw.ref === "string" ? cell.images.get(raw.ref) : undefined;
      if (!image) throw coded("OCR needs a capture from this call", "bad_request");
      const languages = Array.isArray(raw.languages) ? raw.languages.slice(0, 8).filter((l) => typeof l === "string" && LANGUAGE.test(l)) : [];
      const { recognizeText } = await import("./ocr.mjs");
      return recognizeText(Buffer.from(image.data, "base64"), { languages });
    }
    if (method === "scriptLog") {
      // ui.log: the runner already checked this, but it is not trusted.
      if (raw.data === null || typeof raw.data !== "object" || Array.isArray(raw.data)) throw coded("Refused: ui.log takes a plain object", "bad_request");
      const full = scriptLogData(raw.data, true);
      if (Buffer.byteLength(JSON.stringify(full)) > LOG_LIMIT) throw coded(`Refused: ui.log entry over ${LOG_LIMIT} bytes`, "bad_request");
      this.#log({ source: "script", data: scriptLogData(raw.data, Boolean(cell.config.log?.text)) });
      return {};
    }
    if (typeof raw.name !== "string" || !SCRIPT_NAME.test(raw.name)) throw coded("Refused: bad script name", "bad_request");
    if (method === "scriptRun") {
      this.#log({ action: "run script", script: raw.name });
      return {};
    }
    // saveScript
    try {
      // Saving under an existing name replaces it (ui.scripts.source then
      // save is how a script is changed); the log says so.
      const replaced = listScripts().some((s) => s.name === raw.name);
      const file = saveScript(raw.name, raw.code, typeof raw.description === "string" ? raw.description : "");
      this.#log({ action: "save script", script: raw.name, file, ...(replaced ? { replaced: true } : {}) });
      return { file };
    } catch (error) {
      cell.notes.push(`Saving script "${raw.name}" failed: ${error.message}`);
      throw error;
    }
  }

  #exitText = null;

  #exited(code, signal) {
    const why = this.#runner.stderr?.().trim().split("\n").slice(-3).join("\n");
    this.#exitText = `The session process exited (${signal ?? code}); bindings were lost.${why ? `\n${why}` : ""}`;
    this.#closeBackends();
    this.#closed = true;
    if (this.#cell) this.#cell.resolve({ raw: { ok: false, content: [{ type: "text", text: this.#exitText }] } });
    this.#onExit?.(this);
  }

  #fail(text) {
    if (this.#cell) this.#cell.resolve({ raw: { ok: false, content: [{ type: "text", text: `${text} Bindings were lost.` }] } });
    this.kill();
  }

  #closeBackends() {
    for (const device of this.#devices.values()) {
      try {
        device.close?.();
      } catch {
        // already closed
      }
    }
    this.#devices.clear();
    try {
      this.#host.close?.();
    } catch {
      // already closed
    }
  }

  // Ends the runner and drops the backends, and with them this session's
  // approvals.
  kill(signal = "SIGKILL") {
    const child = this.#runner.child;
    try {
      child.kill(signal);
      // A runner that ignores SIGTERM (a cell can install a handler) gets
      // SIGKILL after a short grace.
      if (signal !== "SIGKILL") {
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }, KILL_GRACE_MS);
        timer.unref?.();
        child.once?.("exit", () => clearTimeout(timer));
      }
    } catch {
      // already gone
    }
    this.#closeBackends();
    this.#closed = true;
  }
}

function safeConfig() {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

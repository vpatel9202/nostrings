// The no-privilege side of a session: the vm context cells run in, and the
// `ui` API. It holds no backend, no file access and no environment. Every
// request a cell makes leaves through a proxy backend as a JSON line on
// stdout and is checked, gated, logged and run by the parent (broker.mjs).
// The parent starts this file under `node --permission` (reads limited to
// src/, no child processes, no workers, no writes) and, on macOS, inside a
// deny-default Seatbelt profile (isolation.mjs). The parent treats everything
// this process says as hostile.
//
// stdin:  init | eval | abort | reply        (from the parent)
// stdout: ready | call | stop | done         (to the parent)
import util from "node:util";
import vm from "node:vm";
import { createApi } from "./api.mjs";
import { createCellContext } from "./realm.mjs";
import { SCRIPT_NAME, wrapScript } from "./scripts.mjs";

// Anything a dependency prints must not corrupt the protocol on stdout.
const protocolOut = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest);

function send(message) {
  protocolOut(`${JSON.stringify(message)}\n`);
}

class StoppedError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "Stopped";
  }
}

let config = {};
let helpDoc = "";
let hostPlatform = null;
let scriptsDir = "";
let scripts = new Map(); // name -> {description, source}, a snapshot the parent sends with each cell
let content = [];
let printed = new Set();
let running = false;
let abortReason = null;
let cellNumber = 0;
// Captures this cell received, by their data, so out.image and OCR can name
// them to the parent by reference instead of sending the bytes back.
let imageRefs = new Map();

function pushText(text) {
  if (!running || text === "") return;
  const last = content.at(-1);
  if (last?.type === "text") last.text += `\n${text}`;
  else content.push({ type: "text", text });
}

function show(value) {
  return typeof value === "string" ? value : util.inspect(withoutPrinted(value), { depth: 4, maxArrayLength: 50, maxStringLength: 4000, breakLength: 120 });
}

function withoutPrinted(value, depth = 0) {
  if (typeof value === "string") return printed.has(value) ? "[printed above]" : value;
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => withoutPrinted(v, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutPrinted(v, depth + 1)]));
}

// Requests to the parent. `target` is "host" (this computer's backend),
// "device" (an Android device by serial) or "nostrings" (OCR, saved scripts).
const pending = new Map();
let nextRid = 1;

function call(target, method, params = {}, { serial, device } = {}) {
  const rid = nextRid++;
  return new Promise((resolve, reject) => {
    pending.set(rid, { resolve, reject, device });
    send({ op: "call", rid, target, method, params, ...(target === "device" ? { serial } : {}) });
  });
}

function onReply(message) {
  const waiter = pending.get(message.rid);
  if (!waiter) return;
  pending.delete(message.rid);
  if (waiter.device && message.meta) {
    waiter.device.label = message.meta.label;
    waiter.device.info = message.meta.info;
  }
  if (message.error) {
    const { message: text, code } = message.error;
    const error = code === "stopped" ? new StoppedError(text) : new Error(text);
    if (code) error.code = code;
    waiter.reject(error);
    return;
  }
  const result = message.result;
  if (result && typeof result === "object" && typeof result.data === "string" && message.imageRef) imageRefs.set(result.data, message.imageRef);
  waiter.resolve(result);
}

const hostBackend = {
  get platform() {
    return hostPlatform ?? undefined;
  },
  on() {
    return this;
  },
  request(method, params) {
    return call("host", method, params);
  },
};

const devices = new Map();

function deviceBackend(serial) {
  const key = serial ?? "";
  let device = devices.get(key);
  if (!device) {
    device = {
      platform: "android",
      label: serial ?? "Android device",
      info: null,
      on() {
        return this;
      },
      request(method, params) {
        return call("device", method, params, { serial, device });
      },
      push(localPath, options = {}) {
        return call("device", "_push", { path: String(localPath), ...(options.to != null ? { to: String(options.to) } : {}) }, { serial, device });
      },
    };
    devices.set(key, device);
  }
  return device;
}

const out = {
  text(value) {
    const text = show(value);
    pushText(text);
    if (running) printed.add(text);
  },
  async image(data, mimeType, label) {
    if (!running) return;
    const ref = imageRefs.get(data);
    if (ref) {
      send({ op: "show", ref });
      content.push({ type: "image", ref, label: String(label ?? "") });
    }
    else pushText("(image not shown: only captures from this call can be shown)");
  },
};

function help(topic) {
  if (!topic) return helpDoc;
  const sections = helpDoc.split(/^(?=## )/m);
  const hit = sections.filter((s) => s.toLowerCase().includes(String(topic).toLowerCase()));
  return hit.length ? hit.join("\n") : `No help for "${topic}". Call help() for everything.`;
}

const ctx = {
  backend: hostBackend,
  device: deviceBackend,
  get config() {
    return config;
  },
  out,
  // The parent writes the action log from the requests it sees. Only
  // ui.log's own entries are forwarded; the broker checks them again.
  log(entry) {
    if (entry?.source === "script") return call("nostrings", "scriptLog", { data: entry.data });
  },
  help,
  get cell() {
    return cellNumber;
  },
  checkAbort() {
    if (abortReason) throw new StoppedError(abortReason);
  },
  stop(reason) {
    abortReason = reason;
    send({ op: "stop", reason: String(reason) });
    throw new StoppedError(reason);
  },
  settle() {
    return new Promise((resolve) => setTimeout(resolve, config.settleMs ?? 80));
  },
  // OCR runs in the parent, on a capture it handed this cell.
  ocr(shot, options = {}) {
    const ref = imageRefs.get(shot?.data);
    if (!ref) return Promise.reject(new Error("OCR needs a capture from this call"));
    return call("nostrings", "ocr", { ref, languages: Array.isArray(options.languages) ? options.languages.map(String) : [] });
  },
};

function scriptsApi() {
  const known = () => [...scripts.keys()].sort();
  function check(name) {
    if (typeof name !== "string" || !SCRIPT_NAME.test(name)) {
      throw new Error(`Script names use a-z, 0-9, - and _ (up to 64 characters), starting with a letter or digit; got ${JSON.stringify(name)}`);
    }
  }
  function source(name) {
    check(name);
    const script = scripts.get(name);
    if (!script) {
      const names = known();
      throw new Error(`No saved script "${name}".${names.length ? ` Saved: ${names.join(", ")}` : " None saved yet; ui.scripts.save(name, code, description) saves one."}`);
    }
    return script.source;
  }
  return {
    list() {
      const list = known().map((name) => ({ name, description: scripts.get(name).description }));
      out.text(list.length ? list.map((s) => `${s.name} — ${s.description}`).join("\n") : 'No saved scripts yet. ui.scripts.save("name", code, "what it does") saves one.');
      return list;
    },
    save(name, code, description = "") {
      check(name);
      if (typeof code !== "string" || !code.trim()) throw new Error("ui.scripts.save(name, code, description): code is the script's source as a string");
      const oneLine = String(description).replace(/\s+/g, " ").trim() || name;
      const body = code.replace(/^\/\/ .*\n/, "");
      scripts.set(name, { description: oneLine, source: `// ${oneLine}\n${body.endsWith("\n") ? body : `${body}\n`}` });
      // The parent validates and writes it before this cell's result; a
      // failure is added to the result there.
      call("nostrings", "saveScript", { name, code, description: String(description) }).catch(() => {});
      const file = `${scriptsDir}/${name}.js`;
      out.text(`Saved script "${name}" to ${file}. Run it with await ui.scripts.run("${name}", args), or from a shell: nostrings script ${name} key=value`);
    },
    source,
    async run(name, args = {}) {
      const fn = vm.runInContext(wrapScript(source(name)), context, { filename: `${name}.js` });
      await call("nostrings", "scriptRun", { name });
      return await fn(args);
    },
  };
}

function makeContext() {
  const ui = createApi(ctx);
  ui.scripts = scriptsApi();
  const consoleProxy = Object.fromEntries(
    ["log", "info", "warn", "error", "debug"].map((name) => [
      name,
      (...args) => pushText(args.filter((a) => !(typeof a === "string" && printed.has(a))).map(show).join(" ")),
    ]),
  );
  const sandbox = {
    ui,
    cua: ui,
    help: ui.help,
    sleep: ui.sleep,
    console: consoleProxy,
    nodeRepl: { write: (value) => out.text(value) },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    TextEncoder,
    TextDecoder,
    process: { platform: process.platform, env: {} },
  };
  return createCellContext(sandbox, { name: "nostrings" });
}

let context = makeContext();

async function runCell(message) {
  content = [];
  printed = new Set();
  imageRefs = new Map();
  cellNumber += 1;
  running = true;
  abortReason = null;
  config = message.config && typeof message.config === "object" ? message.config : {};
  scripts = new Map((Array.isArray(message.scripts) ? message.scripts : []).map((s) => [s.name, { description: s.description, source: s.source }]));
  try {
    // The parent already rewrote the cell (transform.mjs), so acorn and its
    // files stay outside what this process can read.
    const result = await vm.runInContext(String(message.code ?? ""), context, { filename: "cell.js", timeout: 30_000 });
    if (result !== undefined && typeof result !== "function" && !(typeof result === "string" && printed.has(result))) {
      pushText(show(result));
    }
    send({ op: "done", id: message.id, ok: true, content });
  } catch (error) {
    const text =
      error instanceof Error
        ? error.name === "Stopped" || error.name === "SyntaxError"
          ? error.message
          : `${error.name}: ${error.message}`
        : `Thrown: ${show(error)}`;
    pushText(text);
    send({ op: "done", id: message.id, ok: false, content });
  } finally {
    running = false;
  }
}

// What this process can reach, measured before any cell runs, so the parent
// can say how isolated the session is. Each probe is harmless when allowed:
// a connect to a socket path that does not exist, a connect to a closed
// local port, signal 0 to the parent, and /usr/bin/true.
async function probe() {
  const report = { node: process.versions.node, permission: Boolean(process.permission) };
  const has = (scope) => {
    try {
      return process.permission.has(scope);
    } catch {
      return null;
    }
  };
  if (process.permission) {
    report.fsWrite = has("fs.write");
    report.childAllowed = has("child");
    report.workerAllowed = has("worker");
  }
  try {
    process.kill(process.ppid, 0);
    report.signalParent = "allowed";
  } catch (error) {
    report.signalParent = error.code ?? "error";
  }
  const net = await import("node:net");
  const connect = (options) =>
    new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      try {
        const socket = net.connect(options);
        socket.once("connect", () => {
          socket.destroy();
          finish("connected");
        });
        socket.once("error", (error) => finish(error.code ?? "error"));
        setTimeout(() => {
          socket.destroy();
          finish("timeout");
        }, 2000);
      } catch (error) {
        finish(error.code ?? "error");
      }
    });
  report.unixSocket = await connect({ path: "/nonexistent-nostrings-probe/probe.sock" });
  report.tcp = await connect({ host: "127.0.0.1", port: 9 });
  try {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("/usr/bin/true", [], { timeout: 2000 });
    report.child = result.error ? (result.error.code ?? "error") : "allowed";
  } catch (error) {
    report.child = error.code ?? "error";
  }
  return report;
}

let chain = Promise.resolve();
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.op === "reply") onReply(message);
    else if (message.op === "abort") {
      if (running) abortReason = message.reason || "Stopped: the script timed out.";
    } else if (message.op === "init") {
      helpDoc = String(message.help ?? "");
      hostPlatform = message.platform ?? null;
      scriptsDir = String(message.scriptsDir ?? "");
    } else if (message.op === "eval") {
      chain = chain.then(() => runCell(message));
    }
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("unhandledRejection", (error) => {
  process.stderr.write(`nostrings runner: unhandled rejection: ${error?.stack ?? error}\n`);
});

send({ op: "ready", report: await probe() });

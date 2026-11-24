// Starts the runner (runner.mjs), the process cells run in, with as little
// privilege as this host allows, and says how isolated it is.
//
// Layers, each feature-detected by actually starting the runner:
//   1. macOS: Seatbelt (`sandbox-exec`), a deny-default profile that lets node
//      start and read its own files, src/ and system libraries. No writes, no
//      network (TCP or Unix sockets), no fork or exec, no signals to others.
//   2. Node's permission model: reads limited to src/, no child processes,
//      no workers, no file writes, no addons. From Node 25 it also denies the
//      network. `--permission` is unflagged from 22.13 and 23.5; before that
//      it is `--experimental-permission`.
//   3. An empty environment.
// If a layer cannot apply (sandbox-exec fails inside another sandbox, an old
// Node), the runner starts without it and the isolation report says so; the
// session prints the warning and `nostrings doctor` shows it.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { JsonLines } from "./jsonlines.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RUNNER = path.join(here, "runner.mjs");
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const READY_MS = 15_000;
// Homebrew's OpenSSL reads its config from <brew>/etc, which the sandbox does
// not open; the runner does no TLS, so it gets an empty config instead.
const OPENSSL_CONFIG = "--openssl-config=/dev/null";

// Paths arrive as -D parameters, never spliced into the profile text.
export const SEATBELT_PROFILE = `(version 1)
(deny default)
(allow process-exec (literal (param "NODE_BIN")))
(allow file-read-metadata)
(allow file-read*
  (literal "/")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/System")
  (subpath "/private/var/db/dyld")
  (subpath "/private/var/db/timezone")
  (literal "/private/etc/localtime")
  (literal "/dev/null")
  (literal "/dev/random")
  (literal "/dev/urandom")
  (subpath (param "NODE_PREFIX"))
  (subpath (param "LIB_CELLAR"))
  (subpath (param "LIB_OPT"))
  (subpath (param "SRC_DIR")))
(allow sysctl-read)
(allow signal (target self))
`;

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// The flag that turns on Node's permission model here, in the order to try.
export function permissionFlags(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  const stable = major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13);
  if (stable) return ["--permission", "--experimental-permission"];
  if (major >= 20) return ["--experimental-permission", "--permission"];
  return [];
}

// Where node and the libraries it links live. Homebrew's node links
// libraries in other kegs, so its whole prefix is readable; elsewhere node's
// own install directory.
// A prefix that is `/` or holds the home directory (node at ~/bin/node)
// would make the user's files readable, so then only the binary is.
function nodePaths() {
  const bin = realpath(process.execPath);
  const home = realpath(os.homedir());
  const safe = (dir) => (dir !== "/" && dir !== home && !home.startsWith(`${dir}/`) ? dir : bin);
  const prefix = safe(path.dirname(path.dirname(bin)));
  // Homebrew's node links libraries from other kegs (libuv, icu4c, ...),
  // reached through <brew>/opt/<keg> and stored in <brew>/Cellar: those two,
  // not all of the Homebrew prefix (its etc/ and var/ hold other programs'
  // config and data).
  const cellar = prefix.indexOf("/Cellar/");
  const brew = cellar > 0 ? prefix.slice(0, cellar) : null;
  const libCellar = brew ? safe(`${brew}/Cellar`) : prefix;
  const libOpt = brew ? safe(`${brew}/opt`) : prefix;
  return { bin, prefix, libCellar, libOpt };
}

let seatbeltProbe;
// Whether sandbox-exec can apply a profile here at all. It cannot inside
// another Seatbelt sandbox (some agent shells run in one).
export function seatbeltAvailable() {
  if (process.platform !== "darwin") return { ok: false, reason: "not macOS" };
  if (seatbeltProbe) return seatbeltProbe;
  try {
    execFileSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: ["ignore", "ignore", "pipe"], timeout: 5000 });
    seatbeltProbe = { ok: true };
  } catch (error) {
    const why = String(error.stderr ?? error.message).trim().split("\n").at(-1);
    seatbeltProbe = { ok: false, reason: why || "sandbox-exec failed" };
  }
  return seatbeltProbe;
}

// Every way to start the runner, strongest first.
function candidates() {
  const src = realpath(here);
  const node = nodePaths();
  const flags = permissionFlags();
  const reads = [`--allow-fs-read=${src}`, `--allow-fs-read=${src}/*`];
  const nodeArgs = [];
  for (const flag of flags) for (const read of reads) nodeArgs.push({ permission: flag, args: [flag, read] });
  nodeArgs.push({ permission: null, args: [] });
  const out = [];
  const seatbelt = seatbeltAvailable();
  if (seatbelt.ok) {
    for (const n of nodeArgs) {
      out.push({
        seatbelt: true,
        permission: n.permission,
        command: SANDBOX_EXEC,
        args: ["-D", `NODE_BIN=${node.bin}`, "-D", `NODE_PREFIX=${node.prefix}`, "-D", `LIB_CELLAR=${node.libCellar}`, "-D", `LIB_OPT=${node.libOpt}`, "-D", `SRC_DIR=${src}`, "-p", SEATBELT_PROFILE, node.bin, OPENSSL_CONFIG, ...n.args, RUNNER],
      });
    }
  }
  for (const n of nodeArgs) out.push({ seatbelt: false, permission: n.permission, command: node.bin, args: [...n.args, RUNNER] });
  return { list: out, seatbelt };
}

// A Unix socket the runner's probe tries to connect to, listening only while
// runners start. Returns {path, close}, or null where none can be made.
async function probeSocket() {
  if (process.platform === "win32") return null;
  const net = await import("node:net");
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nsp-"));
    const file = path.join(dir, "p.sock");
    const server = net.createServer((c) => c.destroy());
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(file, resolve);
    });
    return {
      path: file,
      close() {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch {
    return null;
  }
}

function spawnRunner(candidate, probePath) {
  const args = probePath ? [...candidate.args, probePath] : candidate.args;
  const child = spawn(candidate.command, args, { stdio: ["pipe", "pipe", "pipe"], env: {}, cwd: realpath(here) });
  const lines = new JsonLines(child.stdout);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8000);
    if (process.env.NOSTRINGS_DEBUG) process.stderr.write(chunk);
  });
  // Permanent listeners: an error on the child or its pipes after start must
  // not take down the MCP server or daemon this runs in.
  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});
  child.on("error", () => {});
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      child.kill("SIGKILL");
      reject(new Error(`no ready message within ${READY_MS} ms`));
    }, READY_MS);
    const onMessage = (message) => {
      if (message?.op !== "ready") return;
      cleanup();
      resolve(message.report && typeof message.report === "object" ? message.report : {});
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`exited (${signal ?? code}) before it was ready${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-2).join(" ")}` : ""}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    function cleanup() {
      clearTimeout(timer);
      lines.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    }
    lines.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
  return { child, lines, ready, stderr: () => stderr };
}

const DENIED = new Set(["ERR_ACCESS_DENIED", "EPERM", "EACCES"]);

// What the runner's own probe (run before any cell) says it can reach.
export function assess(candidate, report, notes = []) {
  const warnings = [...notes];
  const fsWriteDenied = candidate.seatbelt || (candidate.permission != null && report.fsWrite === false);
  const childDenied = DENIED.has(report.child);
  const networkDenied = DENIED.has(report.unixSocket) && DENIED.has(report.tcp);
  const seatbelt = candidate.seatbelt && report.signalParent === "EPERM";
  if (process.platform === "darwin" && !seatbelt) warnings.push("the script runner is not in a Seatbelt sandbox");
  if (!candidate.permission) warnings.push(`Node ${process.versions.node} could not start the runner with its permission model`);
  if (!fsWriteDenied) warnings.push("the script runner can write files");
  if (!childDenied) warnings.push("the script runner can start processes");
  if (!networkDenied) {
    warnings.push(
      process.platform === "darwin"
        ? "the script runner is not network-isolated"
        : `runner not network-isolated: Node ${process.versions.node} has no network permission before v25, and there is no sandbox on ${process.platform}`,
    );
  }
  return {
    seatbelt,
    permission: candidate.permission,
    fsWriteDenied,
    childDenied,
    networkDenied,
    envEmpty: true,
    report,
    warnings,
  };
}

export function describeIsolation(iso) {
  const layers = [iso.seatbelt ? "Seatbelt sandbox" : null, iso.permission ? `node ${iso.permission}` : null, "empty environment"].filter(Boolean);
  const denied = [iso.fsWriteDenied && "file writes", iso.childDenied && "processes", iso.networkDenied && "network and sockets"].filter(Boolean);
  return `${layers.join(" + ")}; denied: ${denied.join(", ") || "nothing"}`;
}

// "strict" (the default) requires the Seatbelt sandbox on macOS: if it cannot
// apply, no runner starts. "best-effort" (config `isolation`) starts the
// strongest runner this host allows and warns. Elsewhere it is always best
// effort, with the warning.
export function isolationMode(config) {
  const mode = config?.isolation ?? "strict";
  return mode === "best-effort" ? "best-effort" : "strict";
}

// Starts a runner and returns {child, lines, isolation}. Every start tries
// the strongest settings first. Throws when the runner cannot start, or on
// macOS in strict mode when it cannot start inside Seatbelt.
// `filter` (tests) limits which settings are tried.
export async function startRunner({ config, filter } = {}) {
  const { list, seatbelt } = candidates();
  const strict = process.platform === "darwin" && isolationMode(config ?? safeConfig()) === "strict";
  const notes = [];
  if (process.platform === "darwin" && !seatbelt.ok) notes.push(`sandbox-exec cannot apply here (${seatbelt.reason}); is nostrings itself running inside a sandbox?`);
  let order = strict ? list.filter((c) => c.seatbelt) : list;
  if (filter) order = order.filter(filter);
  const failures = [];
  if (strict && !seatbelt.ok) failures.push(`sandbox-exec: ${seatbelt.reason}`);
  const probe = order.length ? await probeSocket() : null;
  try {
    for (const candidate of order) {
      const runner = spawnRunner(candidate, probe?.path);
      try {
        const report = await runner.ready;
        if (failures.length) notes.push(`stronger runner settings failed: ${failures.at(-1)}`);
        const isolation = assess(candidate, report, notes);
        if (strict && !isolation.seatbelt) {
          runner.child.kill("SIGKILL");
          failures.push("sandbox-exec started, but the runner's probe found it not sandboxed");
          continue;
        }
        return { child: runner.child, lines: runner.lines, stderr: runner.stderr, isolation };
      } catch (error) {
        failures.push(`${candidate.seatbelt ? "sandbox-exec + " : ""}${candidate.permission ?? "plain node"}: ${error.message}`);
        runner.child.kill("SIGKILL");
      }
    }
  } finally {
    probe?.close();
  }
  if (strict) {
    throw new Error(
      "nostrings will not run scripts on this Mac without its Seatbelt sandbox, and the sandbox could not apply:\n" +
        `${failures.join("\n")}\n` +
        "This happens when nostrings itself runs inside another sandbox (some agent shells do). Start it outside that sandbox, " +
        'or accept weaker isolation by setting "isolation": "best-effort" in ~/.nostrings/config.json (see SECURITY.md).',
    );
  }
  throw new Error(`The script runner did not start:\n${failures.join("\n")}`);
}

function safeConfig() {
  try {
    return loadConfig();
  } catch {
    return {};
  }
}

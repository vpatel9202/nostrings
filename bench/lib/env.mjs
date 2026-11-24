// Shared helpers for task setup and verification. Everything here is the
// harness's own oracle: it never goes through the tool under test.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Session } from "../../src/session.mjs";

const run = promisify(execFile);

export const benchDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const repoDir = path.dirname(benchDir);
export const workDir = path.join(os.homedir(), "nostrings-bench");
export const fixtureApp = path.join(benchDir, ".build", "Bench Fixture.app");
export const FIXTURE_BUNDLE_ID = "dev.nostrings.bench-fixture";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sh(file, args, options = {}) {
  const { stdout } = await run(file, args, { maxBuffer: 16 << 20, ...options });
  return stdout.trim();
}

export function osascript(script) {
  return sh("osascript", ["-e", script]);
}

export async function quitApp(name) {
  await osascript(`if application "${name}" is running then tell application "${name}" to quit`).catch(() => {});
  for (let i = 0; i < 30; i++) {
    const running = await osascript(`application "${name}" is running`).catch(() => "false");
    if (running !== "true") return;
    await sleep(100);
  }
}

// Closes only the documents the benchmark opened, so the user's own TextEdit
// work is never discarded, and quits TextEdit only if nothing else is open.
export async function closeBenchTextEdit() {
  await osascript(`
    if application "TextEdit" is running then
      tell application "TextEdit"
        repeat with d in (every document)
          try
            if (path of d as text) contains "${workDir}" then close d saving no
          end try
        end repeat
        if (count of documents) is 0 then quit
      end tell
    end if`).catch(() => {});
  await sleep(500);
}

export async function closeFinderWindow(name) {
  await osascript(`tell application "Finder" to close (every window whose name is "${name}")`).catch(() => {});
}

export async function quitFixture() {
  await sh("pkill", ["-f", "Bench Fixture.app/Contents/MacOS/BenchFixture"]).catch(() => {});
  await sleep(300);
}

export async function launchFixture(mode, out, { target = "" } = {}) {
  await quitFixture();
  fs.rmSync(out, { force: true });
  fs.writeFileSync(path.join(workDir, "fixture.json"), JSON.stringify({ mode, out, target }));
  await sh("open", [fixtureApp, "--args", "--mode", mode, "--out", out, "--target", target]);
  await waitFor(async () => (await osascript(`application id "${FIXTURE_BUNDLE_ID}" is running`).catch(() => "false")) === "true");
  await sleep(800);
}

export async function waitFor(check, { timeoutMs = 10_000, everyMs = 200 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(everyMs);
  }
  return false;
}

// Builds the fixture app bundle when the Swift source is newer than the binary.
export async function buildFixture() {
  const source = path.join(benchDir, "fixture", "BenchFixture.swift");
  const binary = path.join(fixtureApp, "Contents", "MacOS", "BenchFixture");
  if (fs.existsSync(binary) && fs.statSync(binary).mtimeMs >= fs.statSync(source).mtimeMs) return;
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureApp, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${FIXTURE_BUNDLE_ID}</string>
  <key>CFBundleName</key><string>Bench Fixture</string>
  <key>CFBundleExecutable</key><string>BenchFixture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
`,
  );
  await sh("swiftc", ["-O", "-o", binary, source]);
  await sh("codesign", ["--force", "--sign", "-", fixtureApp]);
}

// A nostrings session used only to read state for verification (Calculator's
// display has no scriptable value). Its reads are {emit: false}.
let oracle = null;
export async function oracleRead(appName) {
  oracle ??= new Session({ client: "nostrings bench oracle" });
  const result = await oracle.run(
    `const __app = await ui.getApp(${JSON.stringify(appName)}); await __app.getAXState({emit: false, disableDiffing: true});`,
    { timeoutMs: 20_000 },
  );
  return result.content.map((c) => c.text ?? "").join("\n");
}

// Sends keys through the oracle session, for resets the app can't script.
export async function oracleKeys(appName, keys) {
  oracle ??= new Session({ client: "nostrings bench oracle" });
  const result = await oracle.run(`const __k = await ui.getApp(${JSON.stringify(appName)}); await __k.pressKey(${JSON.stringify(keys)}); undefined;`, {
    timeoutMs: 20_000,
  });
  if (!result.ok) throw new Error(result.content.map((c) => c.text ?? "").join("\n"));
}

// Runs a script in the oracle session. Used by the dry run's scripted solves,
// which prove each task can be done and that verify notices.
export async function oracleRun(code, timeoutMs = 60_000) {
  oracle ??= new Session({ client: "nostrings bench oracle" });
  const result = await oracle.run(code, { timeoutMs });
  const text = result.content.map((c) => c.text ?? "").join("\n");
  if (!result.ok) throw new Error(text);
  return text;
}

export function closeOracle() {
  oracle?.close();
  oracle = null;
}

// ---- Android -----------------------------------------------------------------
// Android tasks run on one device or emulator, named with --android-serial.
// The fixture app is the one `npm run build:android` produces.
export const androidConfig = { serial: null };
export const ANDROID_PACKAGE = "com.nostrings.fixture";

async function androidBackend() {
  return import("../../src/backends/android.mjs");
}

// Installs the fixture and stops it, so each run starts from its first screen.
export async function resetAndroidFixture() {
  const { FIXTURE_APK, resolveSerial, adb } = await androidBackend();
  if (!androidConfig.serial) throw new Error("Android tasks need --android-serial (for example emulator-5554)");
  if (!fs.existsSync(FIXTURE_APK)) throw new Error("fixture app not built; run npm run build:android");
  const serial = await resolveSerial(androidConfig.serial);
  await adb(["-s", serial, "install", "-r", "--user", "0", FIXTURE_APK], { timeout: 120_000 });
  await adb(["-s", serial, "shell", "am", "force-stop", ANDROID_PACKAGE]);
  await adb(["-s", serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP"]).catch(() => {});
}

export async function stopAndroidFixture() {
  const { resolveSerial, adb } = await androidBackend();
  const serial = await resolveSerial(androidConfig.serial).catch(() => null);
  if (serial) await adb(["-s", serial, "shell", "am", "force-stop", ANDROID_PACKAGE]).catch(() => {});
}

// Reads the fixture's labels through a short-lived nostrings session of the
// harness's own, never the model's. The phone allows one automation
// connection, so the model's tool server is closed before verify for Android
// tasks (`verifyAfterClose`), and this session is closed after the read.
export async function androidLabels() {
  const saved = process.env.NOSTRINGS_APPROVAL;
  process.env.NOSTRINGS_APPROVAL = "allow-all";
  const session = new Session({ client: "nostrings bench oracle (android)" });
  try {
    const result = await session.run(
      `const __p = ui.device(${JSON.stringify(androidConfig.serial)}); const __f = await __p.getApp(${JSON.stringify(ANDROID_PACKAGE)}); await __f.getAXState({emit: false, disableDiffing: true});`,
      { timeoutMs: 60_000 },
    );
    const text = result.content.map((c) => c.text ?? "").join("\n");
    if (!result.ok) throw new Error(text.split("\n").at(-1));
    return text;
  } finally {
    session.close();
    if (saved == null) delete process.env.NOSTRINGS_APPROVAL;
    else process.env.NOSTRINGS_APPROVAL = saved;
  }
}

export function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

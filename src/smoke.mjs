// `nostrings smoke`: proves the loop end to end on Calculator through the same
// MCP server an agent would use. It checks that a batched call lands, that a
// binding survives to the next call, that reads diff, and that js_reset drops
// the binding. Nothing here is mocked.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "nostrings.mjs");

function client(env = process.env) {
  const child = spawn(process.execPath, [cli, "mcp"], { stdio: ["pipe", "pipe", "inherit"], env });
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const js = async (code) => {
    const reply = await request("tools/call", { name: "js", arguments: { code, title: "nostrings smoke" } });
    const text = (reply.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return { text, isError: reply.result?.isError ?? true, images: (reply.result?.content ?? []).filter((c) => c.type === "image") };
  };
  return { request, js, close: () => child.stdin.end() };
}

// The frontmost app's name, so the smoke test can prove input stayed in the background.
function frontmostApp() {
  if (process.platform !== "darwin") return null;
  try {
    return execFileSync("osascript", ["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.localizedName.js']).toString().trim();
  } catch {
    return null;
  }
}

// The frontmost app every `everyMs` for `ms`, through lsappinfo (no AppKit:
// an osascript that loads AppKit and runs a loop can itself become frontmost).
// Resolves to the samples [{ms, app}] where the app changed.
async function watchFrontmost(ms, everyMs = 50) {
  const name = () => {
    try {
      const asn = execFileSync("lsappinfo", ["front"]).toString().trim();
      return execFileSync("lsappinfo", ["info", asn]).toString().split("\n")[0].split('"')[1] ?? null;
    } catch {
      return null;
    }
  };
  const seen = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const app = name();
    if (app && seen.at(-1)?.app !== app) seen.push({ ms: Date.now() - t0, app });
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return seen;
}

export async function runSmoke({ screenshot = true, full = false } = {}) {
  const frontBefore = frontmostApp();
  const mcp = client();
  const results = [];
  const step = (name, pass, detail) => {
    results.push(pass);
    const text = detail == null ? "" : String(detail).trim();
    process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${name}${text ? `\n      ${text.split("\n").join("\n      ")}` : ""}\n`);
  };
  try {
    const init = await mcp.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "nostrings smoke", version: "1" },
    });
    const list = await mcp.request("tools/list", {});
    step("MCP handshake", init.result?.serverInfo?.name === "nostrings" && list.result?.tools?.length === 2);

    // One call: bind the app, several actions, one read.
    const first = await mcp.js(`
const calc = await ui.getApp("Calculator");
await calc.pressKey("Escape");
await calc.typeText("6*7=");
await calc.getAXState();`);
    step("batched call types 6*7= and reads 42", !first.isError && /value="42"/.test(first.text), first.isError ? first.text : undefined);

    // Next call: the binding is still there; click by element index; read is a diff.
    const second = await mcp.js(`
const tree = await calc.getAXState({ emit: false, disableDiffing: true });
const idx = (label) => Number(tree.match(new RegExp("^\\\\s*(\\\\d+) button \\"" + label + "\\"", "m"))[1]);
await calc.click(idx("All Clear"));
for (const label of ["7", "Add", "1", "Equals"]) await calc.click(idx(label));
await calc.getAXState();`);
    step("binding persists; index clicks compute 7+1=8; read is a diff", !second.isError && /value="8"/.test(second.text) && /changes since last read/.test(second.text), second.isError ? second.text : undefined);

    // Pixel click on the same space a screenshot uses.
    const third = await mcp.js(`
const tree2 = await calc.getAXState({ emit: false, disableDiffing: true });
const at = (label) => Number(tree2.match(new RegExp("^\\\\s*(\\\\d+) button \\"" + label + "\\"", "m"))[1]);
await calc.click(at("All Clear"));
const [x, y] = await calc.center(at("9"));
await calc.click([x, y]);
await calc.getAXState();`);
    step("pixel click [x, y] lands on the 9 key", !third.isError && /value="9"/.test(third.text), third.isError ? third.text : undefined);

    if (screenshot) {
      const shot = await mcp.js(`const s = await calc.getScreenshot(); s.width + "x" + s.height + " vs view " + calc.view.width + "x" + calc.view.height`);
      const match = shot.text.match(/(\d+)x(\d+) vs view (\d+)x(\d+)/);
      step(
        "screenshot is an image in the same pixel space as clicks",
        !shot.isError && shot.images.length === 1 && match && match[1] === match[3] && match[2] === match[4],
        shot.isError ? shot.text : undefined,
      );
    }

    await mcp.request("tools/call", { name: "js_reset", arguments: {} });
    const after = await mcp.js("typeof calc");
    const resetOk = !after.isError && after.text.trim() === "undefined";
    step("js_reset drops the binding", resetOk, resetOk ? undefined : after.text);

    if (full) {
      // Raw mouse input in a background text editor: a click places the caret,
      // a drag selects, a scroll moves the view. Only real mouse events do these.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nostrings-smoke-"));
      const short = path.join(dir, "nostrings-smoke.txt");
      const long = path.join(dir, "nostrings-smoke-long.txt");
      fs.writeFileSync(short, "AAAA\nBBBB\nCCCC\n");
      fs.writeFileSync(long, Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n"));
      execFileSync("open", ["-g", "-a", "TextEdit", short, long]);
      await new Promise((r) => setTimeout(r, 2500));
      const te = await mcp.js(`
const te = await ui.getApp("TextEdit");
const wins = await te.windows();
const shortWin = wins.find((w) => w.title.startsWith("nostrings-smoke.txt"));
const longWin = wins.find((w) => w.title.startsWith("nostrings-smoke-long"));
const area = async (i) => (await te.getAXState({ window: i, emit: false, disableDiffing: true, frames: true })).match(/text area value="([^"]*)".*@(\\d+),(\\d+)/);
let a = await area(shortWin.index);
const [ax, ay] = [Number(a[2]), Number(a[3])];
await te.click([ax + 8, ay + 10]);
await te.typeText("Y");
const afterClick = (await area(shortWin.index))[1];
await te.drag([ax + 8, ay + 10], [ax + 300, ay + 10]);
await te.typeText("Q");
const afterDrag = (await area(shortWin.index))[1];
const bars = async () => [...(await te.getAXState({ window: longWin.index, emit: false, disableDiffing: true })).matchAll(/scroll bar value="([^"]+)"/g)].map((m) => m[1]).join(",");
const before = await bars();
await te.scroll([300, 300], 15);
const afterScroll = await bars();
JSON.stringify({ afterClick, afterDrag, before, afterScroll, route: te.lastRoute });`);
      let r = {};
      try {
        r = JSON.parse(te.text.trim().split("\n").at(-1));
      } catch {}
      step("background click places the caret (TextEdit)", !te.isError && /^Y/.test(r.afterClick ?? ""), te.isError ? te.text : r.afterClick);
      step("background drag selects text (TextEdit)", !te.isError && /^Q /.test(r.afterDrag ?? ""), te.isError ? undefined : r.afterDrag);
      step("background scroll moves the view (TextEdit)", !te.isError && r.before !== r.afterScroll, te.isError ? undefined : `${r.before} -> ${r.afterScroll}`);
      process.stdout.write(`      (Two test documents are open in TextEdit; close them without saving: ${dir})\n`);
    }

    const frontAfter = frontmostApp();
    if (frontBefore) {
      step("input stayed in the background (frontmost app unchanged)", frontBefore === frontAfter, `${frontBefore} -> ${frontAfter}`);
    }
  } finally {
    mcp.close();
  }
  const passed = results.every(Boolean);
  process.stdout.write(passed ? "\nAll smoke checks passed.\n" : "\nSome smoke checks failed.\n");
  return passed;
}

// `nostrings smoke --android`: the same loop on a phone or emulator, against
// the fixture app (native/android/fixture), which reports every tap, key,
// long press, drag and scroll in a label. The fixture is installed for the
// run and removed after it unless `keep`. Failure details print only the
// fixture's own labels and error codes, never other screen content.
// Where two display-0 captures differ, as "in [x0,y0]-[x1,y1] (n px)".
function changedBox(a, b) {
  if (!a.body || !b.body || a.body.length !== b.body.length) return "";
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, n = 0;
  for (let i = 0; i < a.body.length; i += 4) {
    if (a.body[i] === b.body[i] && a.body[i + 1] === b.body[i + 1] && a.body[i + 2] === b.body[i + 2]) continue;
    const p = i / 4, x = p % a.w, y = Math.floor(p / a.w) + a.top;
    n++;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return n ? `in [${x0},${y0}]-[${x1},${y1}] (${n} px)` : "";
}

export async function runAndroidSmoke({ serial, keep = false } = {}) {
  const { FIXTURE_APK, FIXTURE_PACKAGE, resolveSerial, adb } = await import("./backends/android.mjs");
  const results = [];
  const step = (name, pass, detail) => {
    results.push(pass);
    const text = detail == null ? "" : String(detail).trim().split("\n")[0];
    process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${name}${!pass && text ? `\n      ${text}` : ""}\n`);
  };
  if (!fs.existsSync(FIXTURE_APK)) {
    step("fixture app built", false, "Run: npm run build:android");
    return false;
  }
  let transport;
  try {
    transport = await resolveSerial(serial ?? process.env.ANDROID_SERIAL);
    const install = () => adb(["-s", transport, "install", "-r", "--user", "0", FIXTURE_APK], { timeout: 120_000 });
    await install().catch(async (error) => {
      // A fixture signed by an older build key: replace it.
      if (!/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(error.message)) throw error;
      await adb(["-s", transport, "uninstall", FIXTURE_PACKAGE]);
      await install();
    });
    await adb(["-s", transport, "shell", "am", "force-stop", FIXTURE_PACKAGE]);
  } catch (error) {
    step("fixture app installs", false, error.message);
    return false;
  }
  // The user's screen, watched from outside nostrings: which display has top
  // focus, and a hash of display 0 without its status and navigation bars.
  // Only the hash is kept, never the image.
  const emulator = transport.startsWith("emulator-");
  const watch = async () => {
    const focus = (await adb(["-s", transport, "shell", "dumpsys", "window"]).catch(() => "")).match(/mTopFocusedDisplayId=(-?\d+)/)?.[1] ?? null;
    let hash = null;
    try {
      const raw = execFileSync(process.env.NOSTRINGS_ADB || "adb", ["-s", transport, "exec-out", "screencap"], { maxBuffer: 128 << 20 });
      const w = raw.readUInt32LE(0), h = raw.readUInt32LE(4);
      const header = raw.length - w * h * 4;
      const crypto = await import("node:crypto");
      const body = raw.subarray(header + Math.floor(h * 0.08) * w * 4, header + Math.floor(h * 0.92) * w * 4);
      hash = crypto.createHash("sha1").update(body).digest("hex");
      return { focus, hash, body, w, top: Math.floor(h * 0.08) };
    } catch {}
    return { focus, hash };
  };
  // An emulator's home screen updates its app suggestions after any launch,
  // hidden or not; a static Files screen shows only what nostrings changes.
  if (emulator) {
    await adb(["-s", transport, "shell", "input", "keyevent", "KEYCODE_WAKEUP"]).catch(() => {});
    await adb(["-s", transport, "shell", "wm", "dismiss-keyguard"]).catch(() => {});
    // (Not Settings: it is an ask-first app, and a stray inspect of it would
    // raise an approval dialog on the Mac.)
    const files = (await adb(["-s", transport, "shell", "cmd", "package", "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", "-a", "android.intent.action.MAIN", "com.google.android.documentsui"]).catch(() => "")).trim().split("\n").at(-1);
    if (files && files.includes("/")) await adb(["-s", transport, "shell", "am", "start", "-W", "-n", files]).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
  }
  const before = await watch();
  // The fixture is ours: skip its dialog. Ask-first apps and a locked phone still ask.
  const mcp = client({ ...process.env, NOSTRINGS_APPROVAL: "allow-all" });
  // Runs `code` and parses the JSON its last line prints.
  const run = async (code) => {
    const reply = await mcp.js(code);
    if (reply.isError) return { error: reply.text.trim().split("\n").at(-1) };
    try {
      return { ...JSON.parse(reply.text.trim().split("\n").at(-1)), images: reply.images.length };
    } catch {
      return { error: "unexpected output" };
    }
  };
  try {
    await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "nostrings smoke", version: "1" } });
    const hello = await run(`
const phone = ui.device(${JSON.stringify(transport)});
const fx = await phone.getApp(${JSON.stringify(FIXTURE_PACKAGE)});
await fx.activate();
const tree = () => fx.getAXState({ emit: false, disableDiffing: true, frames: true });
const idx = async (re) => Number((await tree()).match(re)?.[1]);
const label = async (prefix) => (await tree()).match(new RegExp('text "(' + prefix + '[^"]*)"'))?.[1];
JSON.stringify({ ok: /text field/.test(await tree()), device: String(phone), screen: fx.screen });`);
    step(`device connects and reads the fixture (${hello.screen ?? "?"} screen)`, hello.ok === true, hello.error);
    if (!hello.ok) return false;

    const tap = await run(`
await fx.click(await idx(/^\\s*(\\d+) button "Tap me"/im));
const r1 = fx.lastRoute;
await fx.click(await fx.center(await idx(/^\\s*(\\d+) button "Tap me"/im)));
JSON.stringify({ counts: await label("taps"), r1, r2: fx.lastRoute });`);
    step("index click and pixel tap both land", tap.counts?.startsWith("taps: 2"), tap.error ?? tap.counts);

    const long = await run(`
await fx.longPress(await idx(/^\\s*(\\d+) button "Tap me"/im));
JSON.stringify({ counts: await label("taps") });`);
    step("long press lands", /long presses: 1$/.test(long.counts ?? ""), long.error ?? long.counts);

    const typed = await run(`
await fx.click(await idx(/^\\s*(\\d+) text field/m));
await fx.typeText("hello nostrings");
const route = fx.lastRoute;
const echo1 = await label("echo");
await fx.pressKey("BackSpace");
JSON.stringify({ echo1, echo2: await label("echo"), route });`);
    step("typeText fills the field", typed.echo1 === "echo: hello nostrings", typed.error ?? typed.echo1);
    step("pressKey BackSpace deletes a character", typed.echo2 === "echo: hello nostring", typed.error ?? typed.echo2);
    if (hello.screen === "hidden") step("input went to the hidden screen", /^hidden screen/.test(typed.route ?? ""), typed.route);

    const code = await run(`
await fx.click((await fx.find({ role: "button", label: "Code screen" })).index);
await sleep(600);
await fx.click((await fx.find({ label: "Digit 1" })).index);
await fx.typeText("123456");
const got = (await fx.find("code:"))?.label;
await fx.pressKey("Back");
await sleep(400);
if (/window "keyboard/.test(await tree())) await fx.pressKey("Back");
JSON.stringify({ got, back: Boolean(await fx.find({ role: "button", label: "Tap me" })) });`);
    step("typeText fills a six-box code field", code.got === "code: 123456" && code.back === true, code.error ?? `${code.got}, back on main: ${code.back}`);

    const web = await run(`
await fx.click((await fx.find({ role: "button", label: "Web screen" })).index);
let heading, link, greet;
try {
await sleep(1000);
heading = (await fx.find({ role: "heading" }))?.label;
await fx.click((await fx.find({ role: "link" })).index);
// The output line, by its text: older WebViews expose no HTML ids.
const out = async () => (await fx.find({ role: "text", label: /^(nothing yet|link tapped|hello)/ }))?.label;
link = await out();
await fx.click((await fx.find({ role: "text field" })).index);
await fx.typeText("nostrings é 😀 日本");
await fx.click((await fx.find({ role: "button", label: "Greet" })).index);
greet = await out();
} catch (e) {
  greet = "error: " + e.message.split("\\n")[0];
} finally {
  // Back to the main screen even after a failure, so later steps still run.
  await fx.pressKey("Back");
  await sleep(400);
  if (/window "keyboard/.test(await tree())) await fx.pressKey("Back");
}
JSON.stringify({ heading, link, greet, back: Boolean(await fx.find({ role: "button", label: "Tap me" })) });`);
    step("web content reads (heading, link)", web.heading === "Web fixture", web.error ?? `heading ${web.heading}`);
    step("web link, typing and button work", web.link === "link tapped" && web.greet === "hello nostrings é 😀 日本" && web.back === true, web.error ?? `${web.link} / ${web.greet} / back ${web.back}`);

    const gest = await run(`
await fx.click((await fx.find({ role: "button", label: "Gesture screen" })).index);
const pad = await fx.expect({ label: "Gesture pad" });
await fx.pinch(pad.index, { scale: 2 });
await fx.rotate(pad.index, { degrees: 45 });
const got = (await fx.find(/^scale:/))?.label;
await fx.pressKey("Back");
JSON.stringify({ got, back: Boolean(await fx.expect({ role: "button", label: "Tap me" })) });`);
    step("pinch and rotate with two fingers", /^scale: 2\.0\d, angle: 4[45]$/.test(gest.got ?? "") && gest.back === true, gest.error ?? gest.got);

    const slid = await run(`
if (/window "keyboard/.test(await tree())) await fx.pressKey("Back"); // hide the keyboard
const s = (await tree()).match(/^\\s*\\d+ slider "Slider".*@(\\d+),(\\d+) (\\d+)x(\\d+)/m).slice(1).map(Number);
const y = s[1] + s[3] / 2;
await fx.drag([s[0] + s[2] * 0.1, y], [s[0] + s[2] * 0.9, y]);
const v1 = Number((await label("slider")).split(" ")[1]);
await fx.swipe([s[0] + s[2] * 0.9, y], [s[0] + s[2] * 0.3, y]);
JSON.stringify({ v1, v2: Number((await label("slider")).split(" ")[1]) });`);
    step("drag moves the slider", slid.v1 >= 70, slid.error ?? `slider ${slid.v1}`);
    step("swipe moves it back", slid.v2 <= 45 && slid.v2 < slid.v1, slid.error ?? `slider ${slid.v2}`);

    const scrolled = await run(`
const listAt = (await tree()).match(/^\\s*\\d+ list.*@(\\d+),(\\d+) (\\d+)x(\\d+)/m).slice(1).map(Number);
await fx.scroll([listAt[0] + listAt[2] / 2, listAt[1] + listAt[3] / 2], 15);
const t = await tree();
JSON.stringify({ row0: /button "Row 0"/.test(t), first: t.match(/button "(Row \\d+)"/)?.[1] });`);
    step("scroll moves the list", scrolled.row0 === false, scrolled.error ?? `first row ${scrolled.first}`);

    const shot = await run(`
const img = await fx.getScreenshot({ format: "png" });
// A blank or one-color frame would mean nothing was captured: count distinct
// byte values in the compressed image as a cheap proxy for content.
const bytes = new Set(atob(img.data.slice(0, 6000)).slice(64, 4096)).size;
JSON.stringify({ same: img.width === fx.view.width && img.height === fx.view.height, bytes, size: img.data.length });`);
    step("screenshot is in the same pixel space as clicks", shot.same === true && shot.images === 1, shot.error);
    step("screenshot has content", shot.bytes > 100 && shot.size > 20_000, shot.error ?? `${shot.bytes} distinct bytes, ${shot.size} base64 chars`);

    const gone = await run(`
await fx.pressKey("Back");
let code = null;
for (let i = 0; i < 12 && !code; i++) {
  await sleep(250);
  try { await fx.getAXState({ emit: false }); } catch (e) { code = e.code; }
}
JSON.stringify({ code });`);
    step("Back leaves the app, and a read says not_visible", gone.code === "not_visible", gone.error ?? `code ${gone.code}`);

    if (hello.screen === "hidden") {
      const after = await watch();
      step("the phone's screen kept focus", after.focus === before.focus, `top focused display ${before.focus} -> ${after.focus}`);
      // An emulator's screen holds still; a phone's can change under the user.
      if (emulator) step("the phone's screen did not change", after.hash != null && after.hash === before.hash, `display 0 changed ${changedBox(before, after)}`);
      else process.stdout.write(`info  the phone's screen ${after.hash === before.hash ? "did not change" : "changed (the user, a notification, or nostrings)"}\n`);
    }

    await mcp.request("tools/call", { name: "js_reset", arguments: {} });
    const after = await mcp.js("typeof fx");
    step("js_reset drops the binding", !after.isError && after.text.trim() === "undefined", after.text);

    // The phone's own screen, as getApp(name, {foreground: true}) asks.
    const phoneRoute = await run(`
const fp = await ui.device(${JSON.stringify(transport)}).getApp(${JSON.stringify(FIXTURE_PACKAGE)}, { foreground: true });
await fp.activate();
const t1 = await fp.getAXState({ emit: false, disableDiffing: true });
await fp.click(await fp.center(Number(t1.match(/^\\s*(\\d+) button "Tap me"/im)[1])), { raw: true });
const route = fp.lastRoute;
const counts = (await fp.getAXState({ emit: false, disableDiffing: true })).match(/text "(taps[^"]*)"/)?.[1];
await fp.pressKey("Back");
JSON.stringify({ screen: fp.screen, route, counts });`);
    step("{foreground: true} works on the phone's own screen", phoneRoute.screen === "phone" && /^taps: 1/.test(phoneRoute.counts ?? "") && /^foreground/.test(phoneRoute.route ?? ""), phoneRoute.error ?? `${phoneRoute.screen} ${phoneRoute.route} ${phoneRoute.counts}`);

    // The phone's screen is a choice per getApp, not a mark on the app. With
    // the app still open on the phone, getApp without the option goes back to
    // the hidden screen (the copy nostrings opened on the phone is stopped
    // first), and so does a new session after js_reset.
    if (hello.screen === "hidden") {
      const hiddenAgain = `
const bp = await ui.device(${JSON.stringify(transport)}).getApp(${JSON.stringify(FIXTURE_PACKAGE)});
await bp.activate();
const t = await bp.getAXState({ emit: false, disableDiffing: true });
await bp.click(Number(t.match(/^\\s*(\\d+) button "Tap me"/im)[1]), { raw: true });
JSON.stringify({ screen: bp.screen, route: bp.lastRoute });`;
      const open = `
const fg = await ui.device(${JSON.stringify(transport)}).getApp(${JSON.stringify(FIXTURE_PACKAGE)}, { foreground: true });
await fg.activate();
"open";`;
      await adb(["-s", transport, "shell", "am", "force-stop", FIXTURE_PACKAGE]);
      await run(open);
      const same = await run(hiddenAgain);
      step("getApp without {foreground} returns an open phone-screen app to the hidden screen", same.screen === "hidden" && /^hidden screen/.test(same.route ?? ""), same.error ?? `${same.screen} ${same.route}`);
      await adb(["-s", transport, "shell", "am", "force-stop", FIXTURE_PACKAGE]);
      await run(open);
      await mcp.request("tools/call", { name: "js_reset", arguments: {} });
      const reset = await run(hiddenAgain);
      step("after js_reset, getApp without {foreground} uses the hidden screen", reset.screen === "hidden" && /^hidden screen/.test(reset.route ?? ""), reset.error ?? `${reset.screen} ${reset.route}`);
      await adb(["-s", transport, "shell", "am", "force-stop", FIXTURE_PACKAGE]);
    }

    // An app that opens a second screen on the phone's own display while its
    // main one stays on the hidden screen: reads stop with moved_to_phone_screen.
    if (hello.screen === "hidden") {
      await adb(["-s", transport, "shell", "am", "force-stop", FIXTURE_PACKAGE]);
      const moved = await run(`
const mp = await ui.device(${JSON.stringify(transport)}).getApp(${JSON.stringify(FIXTURE_PACKAGE)}, { foreground: false });
await mp.activate();
await mp.click((await mp.find({ role: "button", label: "Open on phone screen" })).index);
let code = null, message = null;
for (let i = 0; i < 16 && !code; i++) {
  await sleep(250);
  try { await mp.getAXState({ emit: false }); } catch (e) { code = e.code; message = String(e.message).split("\\n")[0]; }
}
JSON.stringify({ code, message, screen: mp.screen });`);
      step("an app opening itself on the phone's screen raises moved_to_phone_screen", moved.code === "moved_to_phone_screen", moved.error ?? `code ${moved.code} on ${moved.screen} screen: ${moved.message}`);
      // Put the phone's screen back as it was.
      await adb(["-s", transport, "shell", "am", "force-stop", FIXTURE_PACKAGE]).catch(() => {});
    }
  } finally {
    mcp.close();
    if (!keep) {
      await adb(["-s", transport, "uninstall", FIXTURE_PACKAGE]).catch((error) => {
        process.stdout.write(`      (Could not remove the fixture app; run: adb -s ${transport} uninstall ${FIXTURE_PACKAGE})\n      ${error.message.split("\n")[0]}\n`);
      });
    }
  }
  const passed = results.every(Boolean);
  process.stdout.write(passed ? "\nAll Android smoke checks passed.\n" : "\nSome Android smoke checks failed.\n");
  return passed;
}

// A PNG's pixels (8-bit, not interlaced, RGB or RGBA), enough to hash a
// cropped region of the emulator's own capture. Filters are undone.
function decodePng(buf) {
  let w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o), kind = buf.toString("latin1", o + 4, o + 8), body = buf.subarray(o + 8, o + 8 + len);
    if (kind === "IHDR") [w, h, depth, type, interlace] = [body.readUInt32BE(0), body.readUInt32BE(4), body[8], body[9], body[12]];
    else if (kind === "IDAT") idat.push(body);
    o += 12 + len;
  }
  if (depth !== 8 || interlace || ![2, 6].includes(type)) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const bpp = type === 6 ? 4 : 3, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const data = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? data[dst + x - bpp] : 0, b = y ? data[dst - stride + x] : 0, c = x >= bpp && y ? data[dst - stride + x - bpp] : 0;
      let add = 0;
      if (f === 1) add = a;
      else if (f === 2) add = b;
      else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      data[dst + x] = (raw[src + x] + add) & 255;
    }
  }
  return { w, h, bpp, data };
}

// `nostrings smoke --android --sessions 2`: two independent nostrings sessions
// (two MCP servers, one per-phone broker) act at once, each on its own hidden
// screen, one on each fixture package. It proves each one's input landed only
// in its own app and that the phone's own screen was not touched: focus
// (dumpsys, sampled throughout), a screencap hash of display 0 before and
// after, and on an emulator a capture by the emulator itself
// (`adb emu screenrecord screenshot`), which never goes through nostrings.
export async function runAndroidSessionsSmoke({ serial, keep = false } = {}) {
  const { FIXTURE_APK, FIXTURE_PACKAGE, FIXTURE_APK2, FIXTURE_PACKAGE2, resolveSerial, adb } = await import("./backends/android.mjs");
  const { paths } = await import("./config.mjs");
  const crypto = await import("node:crypto");
  const results = [];
  const step = (name, pass, detail) => {
    results.push(pass);
    const text = detail == null ? "" : String(detail).trim().split("\n")[0];
    process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${name}${!pass && text ? `\n      ${text}` : ""}\n`);
  };
  if (!fs.existsSync(FIXTURE_APK) || !fs.existsSync(FIXTURE_APK2)) {
    step("both fixture apps built", false, "Run: npm run build:android");
    return false;
  }
  const packages = [FIXTURE_PACKAGE, FIXTURE_PACKAGE2];
  let transport;
  try {
    transport = await resolveSerial(serial ?? process.env.ANDROID_SERIAL);
    for (const [pkg, apk] of [[FIXTURE_PACKAGE, FIXTURE_APK], [FIXTURE_PACKAGE2, FIXTURE_APK2]]) {
      const install = () => adb(["-s", transport, "install", "-r", "--user", "0", apk], { timeout: 120_000 });
      await install().catch(async (error) => {
        if (!/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(error.message)) throw error;
        await adb(["-s", transport, "uninstall", pkg]);
        await install();
      });
      await adb(["-s", transport, "shell", "am", "force-stop", pkg]);
    }
  } catch (error) {
    step("fixture apps install", false, error.message);
    return false;
  }
  const emulator = transport.startsWith("emulator-");
  const adbBin = process.env.NOSTRINGS_ADB || "adb";
  const sh = (...args) => adb(["-s", transport, "shell", ...args]).catch(() => "");
  const cropHash = (w, h, bpp, data) => {
    const rows = data.subarray(Math.floor(h * 0.08) * w * bpp, Math.floor(h * 0.92) * w * bpp);
    return crypto.createHash("sha1").update(rows).digest("hex");
  };
  const focus = async () => (await sh("dumpsys", "window")).match(/mTopFocusedDisplayId=(-?\d+)/)?.[1] ?? null;
  const screencap = () => {
    try {
      const raw = execFileSync(adbBin, ["-s", transport, "exec-out", "screencap"], { maxBuffer: 128 << 20 });
      const w = raw.readUInt32LE(0), h = raw.readUInt32LE(4), header = raw.length - w * h * 4;
      const body = raw.subarray(header + Math.floor(h * 0.08) * w * 4, header + Math.floor(h * 0.92) * w * 4);
      return { hash: crypto.createHash("sha1").update(body).digest("hex"), body, w, top: Math.floor(h * 0.08) };
    } catch {
      return {};
    }
  };
  // The emulator's own capture of its main display, taken through its console.
  const consoleShot = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nostrings-emu-"));
    try {
      execFileSync(adbBin, ["-s", transport, "emu", "screenrecord", "screenshot", dir], { timeout: 30_000 });
      for (let i = 0; i < 20; i++) {
        const png = fs.readdirSync(dir).find((f) => f.endsWith(".png"));
        if (png) {
          const { w, h, bpp, data } = decodePng(fs.readFileSync(path.join(dir, png)));
          return cropHash(w, h, bpp, data);
        }
        execFileSync("sleep", ["0.3"]);
      }
      return null;
    } catch {
      return null;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const virtualDisplays = async () => ((await sh("dumpsys", "display")).match(/uniqueId="virtual:/g) ?? []).length;
  const serverRunning = async () => (await sh("ps", "-A", "-o", "ARGS")).split("\n").some((l) => /com\.nostrings\.server\.Server/.test(l) && !/grep/.test(l));
  const sockets = () => fs.readdirSync(paths.home).filter((f) => /^android-.*\.sock$/.test(f));
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

  if (emulator) {
    await sh("input", "keyevent", "KEYCODE_WAKEUP");
    await sh("wm", "dismiss-keyguard");
    // The "About" settings page holds still. (The Files app's empty state
    // animates and made display 0 look changed; started with `am`, not
    // nostrings, so no approval is involved.) Then wait until two captures
    // 2 s apart agree, so a slow first draw is not read as nostrings' doing.
    await sh("am", "start", "-W", "-a", "android.settings.DEVICE_INFO_SETTINGS");
    let last = null;
    for (let i = 0; i < 15; i++) {
      await sleepMs(2000);
      const now = screencap().hash;
      if (now && now === last) break;
      last = now;
    }
  }
  const before = { focus: await focus(), cap: screencap(), emu: emulator ? consoleShot() : null, displays: await virtualDisplays(), sockets: sockets() };
  const A = client({ ...process.env, NOSTRINGS_APPROVAL: "allow-all" });
  const B = client({ ...process.env, NOSTRINGS_APPROVAL: "allow-all" });
  const run = async (mcp, code) => {
    const reply = await mcp.js(code);
    if (reply.isError) return { error: reply.text.trim().split("\n").at(-1) };
    try {
      return JSON.parse(reply.text.trim().split("\n").at(-1));
    } catch {
      return { error: "unexpected output" };
    }
  };
  const open = (pkg) => `
const phone = ui.device(${JSON.stringify(transport)});
const fx = await phone.getApp(${JSON.stringify(pkg)}, { foreground: false });
await fx.activate();
const tree = () => fx.getAXState({ emit: false, disableDiffing: true, frames: true });
const label = async (prefix) => (await tree()).match(new RegExp('text "(' + prefix + '[^"]*)"'))?.[1];
const tap = async () => fx.click((await fx.find({ role: "button", label: "Tap me" })).index);
JSON.stringify({ screen: fx.screen, route: fx.lastRoute });`;
  // Session A: taps, long presses, drags and swipes on the slider, then a word.
  const workA = `
const t0 = Date.now();
for (let i = 0; i < 4; i++) {
  await tap();
  await fx.longPress((await fx.find({ role: "button", label: "Tap me" })).index);
}
const s = (await tree()).match(/^\\s*\\d+ slider "Slider".*@(\\d+),(\\d+) (\\d+)x(\\d+)/m).slice(1).map(Number);
const y = s[1] + s[3] / 2;
const sl = [];
for (let i = 0; i < 3; i++) {
  await fx.drag([s[0] + s[2] * 0.1, y], [s[0] + s[2] * 0.9, y]);
  sl.push(Number((await label("slider")).split(" ")[1]));
  await fx.swipe([s[0] + s[2] * 0.9, y], [s[0] + s[2] * 0.1, y]);
  sl.push(Number((await label("slider")).split(" ")[1]));
}
await fx.click((await fx.find({ role: "text field" })).index);
await fx.typeText("alpha");
JSON.stringify({ t0, t1: Date.now(), taps: await label("taps"), echo: await label("echo"), sl, route: fx.lastRoute, tree: await tree() });`;
  // Session B: six taps, then a different word.
  const workB = `
const t0 = Date.now();
for (let i = 0; i < 6; i++) { await tap(); await sleep(400); }
await fx.click((await fx.find({ role: "text field" })).index);
await fx.typeText("bravo");
await sleep(2500);
JSON.stringify({ t0, t1: Date.now(), taps: await label("taps"), echo: await label("echo"), route: fx.lastRoute, tree: await tree() });`;
  try {
    for (const mcp of [A, B]) await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "nostrings smoke", version: "1" } });
    const [a0, b0] = await Promise.all([run(A, open(FIXTURE_PACKAGE)), run(B, open(FIXTURE_PACKAGE2))]);
    step("both sessions open their app on a hidden screen", a0.screen === "hidden" && b0.screen === "hidden", a0.error ?? b0.error ?? `${a0.screen}, ${b0.screen}`);
    if (a0.screen !== "hidden" || b0.screen !== "hidden") return false;
    const during = await virtualDisplays();
    step("each session has its own display", during === before.displays + 2, `${before.displays} virtual displays before, ${during} with both open`);

    // Both act at once while top focus is sampled from outside.
    const samples = [];
    let sampling = true;
    const poll = (async () => {
      while (sampling) {
        samples.push(await focus());
        await sleepMs(300);
      }
    })();
    const [a, b] = await Promise.all([run(A, workA), run(B, workB)]);
    sampling = false;
    await poll;
    step("the sessions acted at the same time", !a.error && !b.error && a.t0 < b.t1 && b.t0 < a.t1, a.error ?? b.error ?? `A ${a.t1 - a.t0} ms, B ${b.t1 - b.t0} ms, offset ${b.t0 - a.t0} ms`);
    step("A's input landed in A's app", a.taps === "taps: 4, long presses: 4" && a.echo === "echo: alpha" && a.sl?.filter((v, i) => i % 2 === 0).every((v) => v >= 70) && a.sl?.filter((v, i) => i % 2 === 1).every((v) => v <= 30), a.error ?? `${a.taps}; ${a.echo}; slider ${a.sl}`);
    step("B's input landed in B's app", b.taps === "taps: 6, long presses: 0" && b.echo === "echo: bravo", b.error ?? `${b.taps}; ${b.echo}`);
    step("neither app saw the other's input", !/alpha/.test(b.tree ?? "alpha") && !/bravo/.test(a.tree ?? "bravo") && /^hidden screen/.test(a.route ?? "") && /^hidden screen/.test(b.route ?? ""), `${a.route} / ${b.route}`);
    const bad = samples.filter((f) => f !== "0");
    step("top focus stayed on display 0 throughout", samples.length >= 3 && bad.length === 0, `${samples.length} samples, ${bad.length} not on display 0 (${[...new Set(bad)].join(",")})`);

    const after = { focus: await focus(), cap: screencap(), emu: emulator ? consoleShot() : null };
    step("top focus is on display 0 after", after.focus === "0", `top focused display ${before.focus} -> ${after.focus}`);
    if (emulator) {
      step("display 0 unchanged (screencap hash)", after.cap.hash != null && after.cap.hash === before.cap.hash, `screencap of display 0 changed ${changedBox(before.cap, after.cap)}`);
      step("display 0 unchanged (emulator's own capture)", after.emu != null && before.emu != null && after.emu === before.emu, before.emu == null || after.emu == null ? "emulator console capture failed" : "the emulator's capture of display 0 changed");
    } else {
      process.stdout.write(`info  the phone's screen ${after.cap.hash === before.cap.hash ? "did not change" : "changed (the user, a notification, or nostrings)"}\n`);
    }

    // Ending one session closes only its display; the other keeps reading.
    await A.request("tools/call", { name: "js_reset", arguments: {} });
    await sleepMs(1000);
    const left = await run(B, `JSON.stringify({ echo: await label("echo") })`);
    const remaining = await virtualDisplays();
    step("resetting A leaves B working", left.echo === "echo: bravo" && remaining === before.displays + 1, left.error ?? `${left.echo}, ${remaining} virtual displays`);
    await B.request("tools/call", { name: "js_reset", arguments: {} });
  } finally {
    A.close();
    B.close();
  }
  // Both sessions are gone: the broker leaves after its idle window.
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    await sleepMs(1000);
    gone = sockets().every((s) => before.sockets.includes(s)) && !(await serverRunning());
  }
  step("after both end: no broker socket and no server left", gone, `sockets ${sockets().join(",")}`);
  const finalDisplays = await virtualDisplays();
  step("after both end: no virtual display left", finalDisplays === before.displays, `${finalDisplays} virtual displays, ${before.displays} before`);
  for (const pkg of packages) await sh("am", "force-stop", pkg);
  if (!keep) {
    for (const pkg of packages) await adb(["-s", transport, "uninstall", pkg]).catch(() => {});
    const left = (await sh("pm", "list", "packages", "com.nostrings.fixture")).trim();
    step("after both end: no fixture package left", left === "", left);
  }
  const passed = results.every(Boolean);
  process.stdout.write(passed ? "\nAll two-session Android smoke checks passed.\n" : "\nSome two-session Android smoke checks failed.\n");
  return passed;
}

// `nostrings smoke --macos`: every capability row the fixture app
// (native/macos/fixture) can show, through the MCP server. The fixture logs
// what reached it, so each check reads that log, not a model. Background
// checks run first with the frontmost app checked; the last few use the
// foreground route on purpose. The fixture is quit at the end and the
// clipboard is put back.
export async function runMacSmoke({ keep = false, foreground = true } = {}) {
  const fixture = await import("./macos-fixture.mjs");
  const { MacBackend } = await import("./backends/macos.mjs");
  const results = [];
  const step = (name, pass, detail) => {
    results.push(pass);
    const text = detail == null ? "" : String(detail).trim();
    process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${name}${!pass && text ? `\n      ${text.split("\n").slice(0, 6).join("\n      ")}` : ""}\n`);
  };
  process.stdout.write("Building Nostrings Fixture if needed...\n");
  await fixture.buildFixture();
  await fixture.launchFixture();
  const raw = new MacBackend({ client: "nostrings smoke" });
  // Keep the user's clipboard (all of it) in the helper; put it back at the
  // end. The stash is the helper's, so the fixture's pid just passes the gate.
  const fixturePid = (await raw.request("resolveApp", { query: fixture.FIXTURE_BUNDLE_ID })).pid;
  await raw.request("pasteStash", { pid: fixturePid, op: "stash", text: "" }).catch(() => {});
  const frontBefore = frontmostApp();
  const mcp = client();
  const since = () => fixture.readFixtureLog().length;
  const events = (from, name) => fixture.readFixtureLog().slice(from).filter((e) => e.event === name);
  const run = async (code) => {
    const r = await mcp.js(code);
    return r;
  };
  const check = async (name, code, eventName, test = () => true) => {
    const from = since();
    const r = await run(code);
    await new Promise((res) => setTimeout(res, 300));
    const got = events(from, eventName);
    step(name, !r.isError && got.some(test), r.isError ? r.text : JSON.stringify(got.slice(-2)) || "no event");
    return r;
  };
  try {
    await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "nostrings smoke", version: "1" } });
    const first = await run(`const fx = await ui.getApp("${fixture.FIXTURE_BUNDLE_ID}"); await fx.getAXState();`);
    step("read: form fields are named by their labels", !first.isError && /text field "Name"/.test(first.text) && /pop up button "Color"/.test(first.text), first.text.slice(0, 400));
    const web = await run(`await fx.expect({role: "heading", label: "Web Fixture"}, {timeout: 5000}); (await fx.find({role: "button", label: "Web button"})) != null`);
    step("read: web content inside the app", !web.isError && /true/.test(web.text), web.text.slice(0, 300));
    await check("menu bar item, background", `await fx.menu("Fixture > Beta")`, "menu", (e) => e.item === "Beta");
    await check("submenu item", `await fx.menu(["Fixture", "More", "Gamma"])`, "menu", (e) => e.item === "Gamma");
    await check("menu shortcut in the background (Cmd+Shift+A)", `await fx.pressKey("super+shift+a"); console.log(fx.lastRoute)`, "menu", (e) => e.item === "Alpha");
    await check("pop-up: open and pick in one step", `await fx.select({id: "color"}, "Purple")`, "popup", (e) => e.item === "Purple");
    await check("context menu pick", `await fx.contextMenu({id: "contextTarget"}, "Rename Item")`, "menu", (e) => e.item === "Rename Item");
    await check("checkbox through accessibility", `await fx.click((await fx.find({role: "checkbox", label: "Subscribe"})).index)`, "checkbox");
    await check("type any characters (accents, emoji, CJK)", `await fx.click((await fx.find({id: "name"})).index); await fx.pressKey("super+a BackSpace"); await fx.typeText("Zoë 🎉 東京")`, "text", (e) => e.value === "Zoë 🎉 東京");
    await check("paste long text, clipboard put back", `await fx.click((await fx.find({id: "notes"})).index); await fx.paste("${"lorem ipsum ".repeat(20).trim()} ✓")`, "notes", (e) => e.value.endsWith("✓"));
    await check("typeText {exact: true} inserts through accessibility", `await fx.click((await fx.find({id: "notes"})).index); await fx.pressKey("super+a BackSpace"); await fx.typeText("nostrings exact 0123", {exact: true}); if (!/^ax-insert/.test(fx.lastRoute)) throw new Error("route " + fx.lastRoute)`, "notes", (e) => e.value === "nostrings exact 0123");
    const noField = await run(`let code = "no error"; try { await fx.click((await fx.find({id: "canvas"})).index); await fx.typeText("x", {exact: true}); } catch (e) { code = e.code; } code`);
    step("typeText {exact: true} without a text field fails (exact_unavailable)", /exact_unavailable/.test(noField.text), noField.text);
    await check("type into web content", `await fx.click((await fx.find({role: "text field", text: "Web field"})).index); await fx.typeText("web ok")`, "web", (e) => e.what === "input:web ok");
    await check("click web content", `await fx.click((await fx.find({role: "button", label: "Web button"})).index)`, "web", (e) => e.what === "button");
    const canvas = `(await fx.find({id: "canvas"})).index`;
    await check("press and hold (700 ms)", `await fx.press(${canvas}, {ms: 700})`, "canvas.up", (e) => e.heldMs >= 650);
    await check("double click", `await fx.doubleClick(${canvas})`, "canvas.down", (e) => e.clicks === 2);
    await check("right click", `await fx.rightClick(${canvas}, {raw: true})`, "canvas.right");
    await check("middle click", `await fx.click(${canvas}, {button: "middle"})`, "canvas.other", (e) => e.button === 2);
    await check("scroll", `await fx.scroll(${canvas}, 3)`, "canvas.scroll", (e) => e.dy !== 0);
    await check("pinch (trackpad gesture)", `await fx.pinch(${canvas}, {scale: 1.5})`, "canvas.pinch", (e) => Math.abs(e.total - 0.5) < 0.05);
    await check("rotate (trackpad gesture)", `await fx.rotate(${canvas}, {degrees: 30})`, "canvas.rotate", (e) => e.total === -30);
    await check("window move", `await fx.window().move(180, 140)`, "window.moved");
    await check("window resize", `await fx.window().resize(800, 790)`, "window.resized", (e) => e.w === 800);
    await check("window minimize", `await fx.window().minimize()`, "window.minimized");
    await check("window restore", `await fx.window().restore()`, "window.restored");
    await check("new window, from the menu", `await fx.menu("File > New Window")`, "window.new");
    const notice = await run(`await fx.getAXState()`);
    step("read notes the window that opened", /\(windows: .*opened/.test(notice.text), notice.text.split("\n").slice(-2).join(" "));
    await check("close a window", `await fx.window((await fx.windows()).find((w) => /Fixture Window/.test(w.title)).index).close()`, "window.closed", (e) => /Fixture Window/.test(e.title));
    {
      // A new window and a secondary window opened in the background; a
      // second after the secondary one the fixture activates itself (as a
      // report said Firefox did). The focus guard must give focus
      // back: the frontmost app stays the same for 3 s, and the next read says so.
      const from = since();
      const watching = watchFrontmost(3000);
      const opened = await run(`await fx.menu("File > New Window"); await fx.menu("File > Secondary Window"); fx.lastRoute`);
      const seen = await watching;
      const tried = events(from, "app.activated").length > 0;
      // The guard reverts an activation it cannot prevent, so a sample can
      // catch the fixture in front for a moment; more than 300 ms is a fail.
      const awayMs = seen.map((s, k) => (s.app === seen[0].app ? 0 : (seen[k + 1]?.ms ?? 3000) - s.ms));
      const longest = Math.max(0, ...awayMs);
      const told = await run(`await fx.getAXState()`);
      const noticed = /\(focus: .*gave focus back/.test(told.text);
      step(
        "new and secondary window in the background: the user's app stays frontmost (any switch undone within 300 ms)",
        !opened.isError && tried && seen.length > 0 && longest <= 300 && seen.at(-1).app === seen[0].app && noticed,
        `${opened.isError ? opened.text : `route ${opened.text.trim()}`}; fixture activated itself: ${tried}; frontmost: ${seen.map((s) => `${s.ms} ms ${s.app}`).join(", ") || "not sampled"}; notice on next read: ${noticed}`,
      );
      await run(`for (let i = 0; i < 4; i++) { const w = (await fx.windows()).find((x) => /Fixture Window|Fixture Secondary/.test(x.title)); if (!w) break; await fx.window(w.index).close(); }`);
    }
    await check("sheet: open, type, OK", `await fx.click((await fx.find({label: "Show Sheet"})).index); await fx.expect({id: "sheetField"}); await fx.click((await fx.find({id: "sheetField"})).index); await fx.typeText("in sheet"); await fx.click((await fx.find({role: "button", label: "OK"})).index)`, "sheet", (e) => e.result === "OK" && e.text === "in sheet");
    await check("alert: pick a button", `await fx.click((await fx.find({label: "Show Alert"})).index); await fx.click((await fx.expect({role: "button", label: "Discard"})).index)`, "alert", (e) => e.result === "Discard");
    await check("hide and unhide the app", `await fx.hide(); await sleep(300); await fx.unhide()`, "app.unhidden");
    // SwiftUI exposes the same controls differently; drive each one.
    await check("SwiftUI window opens", `await fx.menu("File > SwiftUI Window"); await sleep(600); const SW = {window: (await fx.windows()).find((w) => w.title === "SwiftUI Fixture").index}; const sf = (q) => fx.find(q, SW);`, "window.new", (e) => e.title === "SwiftUI Fixture");
    await check("SwiftUI toggle", `await fx.click((await sf({role: "checkbox", label: "Dark Roast"})).index)`, "swiftui.toggle", (e) => e.on === true);
    await check("SwiftUI picker", `await fx.select((await sf({role: "pop up button", label: "Flavor"})).index, "Caramel")`, "swiftui.picker", (e) => e.item === "Caramel");
    await check("SwiftUI text field", `await fx.click((await sf({role: "text field"})).index); await fx.typeText("Zoë")`, "swiftui.text", (e) => e.value === "Zoë");
    await check("SwiftUI slider", `await fx.performSecondaryAction((await sf({role: "slider"})).index, "Increment")`, "swiftui.slider", (e) => e.value === 4);
    await check("SwiftUI stepper", `await fx.performSecondaryAction((await sf({role: "stepper"})).index, "Increment")`, "swiftui.stepper", (e) => e.value === 2);
    await check("SwiftUI menu", `await fx.select((await sf({role: "menu button", label: "More Actions"})).index, "Archive")`, "swiftui.menu", (e) => e.item === "Archive");
    await check("SwiftUI list row", `await fx.click((await sf({role: "text", value: "Banana"})).index)`, "swiftui.list", (e) => e.item === "Banana");
    await check("SwiftUI button", `await fx.click((await sf({role: "button", label: "Place Order"})).index)`, "swiftui.button", (e) => e.flavor === "Caramel" && e.name === "Zoë");
    await run(`await fx.window(SW.window).close()`);
    const frontAfter = frontmostApp();
    if (frontBefore) step("everything above stayed in the background", frontBefore === frontAfter, `${frontBefore} -> ${frontAfter}`);

    // Foreground on purpose: these move the real pointer or need the app in
    // front, so they are skipped with --background-only (someone is at the Mac).
    if (!foreground) {
      process.stdout.write("      (foreground checks skipped: --background-only)\n");
      if (!keep) await check("quit the app", `await fx.quit()`, "quit");
      const ok = results.every(Boolean);
      process.stdout.write(ok ? `\nAll ${results.length} background macOS checks passed.\n` : `\n${results.filter((r) => !r).length} of ${results.length} macOS checks failed.\n`);
      return ok;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nostrings-smoke-"));
    const file = path.join(dir, "pick-me.txt");
    fs.writeFileSync(file, "nostrings smoke\n");
    await check("drop a file on the app (foreground)", `await fx.dropFiles((await fx.find({id: "dropTarget"})).index, ${JSON.stringify([file])})`, "drop", (e) => e.files === "pick-me.txt");
    await check("hover (foreground)", `await fx.hover([20, 20]); await fx.hover(${canvas})`, "canvas.enter");
    await check("open panel: choose a file (foreground)", `await fx.menu("File > Open…"); await sleep(1200); await fx.choosePath(${JSON.stringify(file)})`, "open", (e) => e.ok && e.path.endsWith("pick-me.txt"));
    await check("save panel: name and folder (foreground)", `await fx.menu("File > Save…"); await sleep(1200); await fx.choosePath(${JSON.stringify(path.join(dir, "named.txt"))})`, "save", (e) => e.ok && e.path.endsWith("named.txt"));
    await check("full screen", `await fx.window().fullScreen(true); await sleep(2500)`, "window.fullscreen", (e) => e.on === true);
    const away = await run(`await ui.pressKey("ctrl+Left"); await sleep(1500); let code = "read"; try { await fx.getAXState({emit: false}); } catch (e) { code = e.code; } code`);
    step("a full-screen window on another Space says so (other_space)", /other_space/.test(away.text), away.text);
    await check("activate switches to its Space; restore leaves full screen", `await fx.activate(); await sleep(1500); await fx.window().restore(); await sleep(2500)`, "window.fullscreen", (e) => e.on === false);
    const mods = execFileSync("osascript", ["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); $.NSEvent.modifierFlags']).toString().trim();
    step("no modifier key left held down", mods === "0", `modifier flags ${mods}`);
    const shot = await run(`const s = await ui.screenshot({emit: false}); s.width + "x" + s.height`);
    step("whole-screen screenshot", !shot.isError && /\d+x\d+/.test(shot.text), shot.text);
    const wins = await run(`(await ui.windows({emit: false})).some((w) => w.bundleId === "${fixture.FIXTURE_BUNDLE_ID}")`);
    step("every window on screen, with owners", !wins.isError && /true/.test(wins.text), wins.text);
    const extras = await run(`(await ui.menuExtras({emit: false})).length`);
    step("menu bar extras listed", !extras.isError && Number(extras.text.trim()) > 0, extras.text);

    // The helper keeps an approved app's requests to that app (ns-csj), and
    // drops queued and running input on a stop (ns-j23). These go to the
    // helper directly (`raw`, where the fixture is approved), not through a
    // script.
    const layout = JSON.parse((await run(`JSON.stringify({ windows: await ui.windows({emit: false}), displays: await ui.displays() })`)).text.trim().split("\n").at(-1));
    const other = layout.windows.find((w) => w.pid !== fixturePid && w.bundleId !== "io.github.vpatel9202.nostrings.helper" && w.layer === 0 && w.frame[2] > 50 && w.frame[3] > 50);
    if (other) {
      const capture = await raw.request("screenshot", { pid: fixturePid, windowId: other.windowId, width: 100, height: 100 }).then(() => "captured", (e) => e.code);
      step(`a capture of another app's window is refused (${other.app})`, capture === "not_owned", capture);
    } else step("a capture of another app's window is refused", false, "no other app's window on screen to try");
    // Points outside the fixture's windows, picked so that a broken check
    // could do little: move and scroll over another app's window (the
    // pointer moves, or it scrolls a line), and a click far off every
    // display. The helper must refuse each before posting anything.
    const inside = (p, f) => p[0] >= f[0] && p[1] >= f[1] && p[0] < f[0] + f[2] && p[1] < f[1] + f[3];
    const fixtureWindows = layout.windows.filter((w) => w.pid === fixturePid);
    let over = null;
    let overApp = null;
    for (const w of layout.windows.filter((x) => x.pid !== fixturePid && x.bundleId !== "io.github.vpatel9202.nostrings.helper" && x.layer === 0)) {
      for (let gy = 0.1; gy < 0.95 && !over; gy += 0.1) {
        for (let gx = 0.1; gx < 0.95 && !over; gx += 0.1) {
          const p = [Math.round(w.frame[0] + w.frame[2] * gx), Math.round(w.frame[1] + w.frame[3] * gy)];
          if (!fixtureWindows.some((f) => inside(p, f.frame))) [over, overApp] = [p, w.app];
        }
      }
      if (over) break;
    }
    if (over) {
      const moved = await raw.request("move", { pid: fixturePid, x: over[0], y: over[1] }).then(() => "moved", (e) => e.code);
      const scrolled = await raw.request("scroll", { pid: fixturePid, x: over[0], y: over[1], dy: 1 }).then(() => "scrolled", (e) => e.code);
      const clicked = await raw.request("click", { pid: fixturePid, x: -100000, y: -100000, button: "left", count: 1, mods: [] }).then(() => "clicked", (e) => e.code);
      step(
        `foreground pointer input outside the app's windows is refused (over ${overApp}, and off screen)`,
        moved === "outside_app" && scrolled === "outside_app" && clicked === "outside_app",
        `move: ${moved}, scroll: ${scrolled}, click: ${clicked}`,
      );
    } else step("foreground pointer input outside the app's windows is refused", false, "no other app's window clear of the fixture to aim at");
    {
      const tree = await raw.request("axTree", { pid: fixturePid });
      const node = tree.nodes.find((n) => n.id === "canvas");
      const [cx, cy] = [node.frame[0] + node.frame[2] / 2, node.frame[1] + node.frame[3] / 2];
      const from = since();
      const burst = Array.from({ length: 40 }, () =>
        raw.request("scroll", { pid: fixturePid, x: cx, y: cy, dy: 3, mode: "background", windowId: tree.window.windowId }).then(() => "ok", (e) => e.code),
      );
      await new Promise((r) => setTimeout(r, 400));
      await raw.request("cancel");
      const outcomes = await Promise.all(burst);
      await new Promise((r) => setTimeout(r, 500));
      const atStop = events(from, "canvas.scroll").length;
      await new Promise((r) => setTimeout(r, 1500));
      const later = events(from, "canvas.scroll").length;
      const cancelled = outcomes.filter((o) => o === "cancelled").length;
      const after = await raw.request("ping").then(() => "ok", (e) => e.code);
      step(
        "a burst of 40 scrolls, then stop: the rest are dropped and nothing arrives after",
        cancelled >= 20 && atStop > 0 && later === atStop && after === "ok",
        `${outcomes.filter((o) => o === "ok").length} ran, ${cancelled} cancelled; scroll events ${atStop}, then ${later}; next request ${after}`,
      );
    }
    if (!keep) await check("quit the app", `await fx.quit()`, "quit");
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    mcp.close();
    const finder = await raw.request("resolveApp", { query: "com.apple.finder" }).catch(() => null);
    const ok = await raw.request("pasteStash", { pid: fixturePid, op: "restore" }).then(() => true, () => false);
    if (!ok && finder) await raw.request("pasteStash", { pid: finder.pid, op: "restore" }).catch(() => {});
    if (!keep) await fixture.quitFixture();
    raw.close?.();
  }
  const passed = results.every(Boolean);
  process.stdout.write(passed ? `\nAll ${results.length} macOS checks passed.\n` : `\n${results.filter((r) => !r).length} of ${results.length} macOS checks failed.\n`);
  return passed;
}

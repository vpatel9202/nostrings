// Unit tests for the pure parts: cell rewriting, key parsing, tree diffs, and
// the image/screen coordinate mapping. GUI behavior is covered by `nostrings smoke`.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { App, findWindow, pickWindow } from "../src/api.mjs";
import { diffTrees, formatTree } from "../src/axformat.mjs";
import { toImage, toScreen, viewFor } from "../src/geometry.mjs";
import { parseChord, parseKeys } from "../src/keys.mjs";
import { createCellContext } from "../src/realm.mjs";
import { transformCell } from "../src/transform.mjs";

function session() {
  const context = vm.createContext({});
  return (code) => vm.runInContext(transformCell(code), context);
}

test("top-level bindings persist across cells and can be redeclared", async () => {
  const run = session();
  assert.equal(await run("const a = await Promise.resolve(2); let b = a * 3; b"), 6);
  assert.equal(await run("a + b"), 8);
  assert.equal(await run("const a = 10; a"), 10);
  assert.equal(await run("function twice(x) { return x * 2 } class Box { constructor(v) { this.v = v } }"), undefined);
  assert.equal(await run("new Box(twice(a)).v"), 20);
});

test("destructuring and imports become persistent bindings", async () => {
  const run = session();
  await run("const { x, y: [z] } = { x: 1, y: [2] }");
  assert.equal(await run("x + z"), 3);
});

test("rejected top-level await surfaces as a rejection, not a hang", async () => {
  const run = session();
  await assert.rejects(run("await Promise.reject(new Error('boom'))"), /boom/);
});

test("syntax errors report a location", () => {
  assert.throws(() => transformCell("const = 1"), /SyntaxError: .*line 1/);
});

test("key chords parse xdotool syntax", () => {
  assert.deepEqual(parseChord("ctrl+a"), { key: "a", mods: ["ctrl"] });
  assert.deepEqual(parseChord("super+shift+Tab"), { key: "Tab", mods: ["super", "shift"] });
  assert.deepEqual(parseChord("Return"), { key: "Return", mods: [] });
  assert.deepEqual(parseChord("cmd+c"), { key: "c", mods: ["super"] });
  assert.deepEqual(parseChord("ctrl++"), { key: "plus", mods: ["ctrl"] });
  assert.deepEqual(parseKeys("ctrl+a BackSpace").map((c) => c.key), ["a", "BackSpace"]);
  assert.throws(() => parseChord("hyper+a"), /Unknown modifier/);
});

const nodes = [
  { i: 0, d: 0, role: "AXWindow", title: "Calc" },
  { i: 1, d: 1, role: "AXStaticText", desc: "Edit field", value: "42" },
  { i: 2, d: 1, role: "AXButton", desc: "7", actions: ["AXPress"] },
];

test("tree lines are compact and diffs are keyed by index", () => {
  const before = formatTree(nodes);
  assert.deepEqual(before, ['0 window "Calc"', '\t1 text "Edit field" value="42"', '\t2 button "7"']);
  const after = formatTree([nodes[0], { ...nodes[1], value: "7" }, { i: 3, d: 1, role: "AXButton", desc: "8" }]);
  assert.deepEqual(diffTrees(before, after), ['~\t1 text "Edit field" value="7"', '+\t3 button "8"', "- removed: 2"]);
  assert.deepEqual(diffTrees(before, before), []);
});

test("an element that only moved deeper is not a change", () => {
  const before = formatTree(nodes);
  const after = formatTree([nodes[0], { i: 9, d: 1, role: "AXGroup" }, { ...nodes[1], d: 2 }, { ...nodes[2], d: 2 }]);
  assert.deepEqual(diffTrees(before, after), ["+\t9 group"]);
});

test("tooltips and field editors never become the default window", () => {
  const main = { index: 1, windowId: 10, frame: [0, 0, 900, 500], main: true, focused: false, title: "Docs" };
  const tooltip = { index: 0, windowId: 11, frame: [100, 100, 362, 50], focused: true, title: "" };
  const editor = { index: 0, frame: [100, 100, 55, 16], focused: true, title: "" };
  const desktop = { index: 2, frame: [0, 0, 1710, 1112], title: "" };
  assert.equal(pickWindow([tooltip, main, desktop]), main);
  assert.equal(pickWindow([editor, main, desktop], { windowId: 10 }), main);
  // A new normal window that takes focus (settings, a new document) wins.
  const settings = { index: 0, windowId: 12, frame: [50, 50, 600, 400], focused: true, title: "Settings" };
  assert.equal(pickWindow([settings, main], { windowId: 10 }), settings);
  // ...unless the caller picked a window explicitly.
  assert.equal(pickWindow([settings, main], { windowId: 10, explicit: true }), main);
});

test("an existing window that takes focus does not take over the default", () => {
  const page = { index: 1, windowId: 10, frame: [0, 0, 900, 500], main: false, focused: false, title: "Page" };
  const devtools = { index: 0, windowId: 11, frame: [0, 0, 900, 500], main: true, focused: true, title: "Developer Tools — Page" };
  // DevTools was already open at the last read: keep working in the page.
  assert.equal(pickWindow([devtools, page], { windowId: 10, known: new Set([10, 11]) }), page);
  // DevTools just opened: follow it.
  assert.equal(pickWindow([devtools, page], { windowId: 10, known: new Set([10]) }), devtools);
});

test("a window option names an index, a title, a RegExp, or an id", () => {
  const windows = [
    { index: 0, windowId: 11, title: "Developer Tools — Page" },
    { index: 1, windowId: 10, title: "Page" },
  ];
  assert.equal(findWindow(windows, 1), windows[1]);
  assert.equal(findWindow(windows, "Page"), windows[1]);
  assert.equal(findWindow(windows, "developer tools"), windows[0]);
  assert.equal(findWindow(windows, /^Developer/), windows[0]);
  // A RegExp from a cell's vm context.
  assert.equal(findWindow(windows, vm.runInNewContext("/^Developer/")), windows[0]);
  assert.equal(findWindow(windows, { id: 10 }), windows[1]);
  assert.equal(findWindow(windows, "Nope"), undefined);
  assert.throws(() => findWindow(windows, true), TypeError);
});

// An App over a fake backend whose tree the test can change between reads.
function fakeApp() {
  const state = { value: "0", title: "Calc" };
  const printed = [];
  const ctx = {
    config: { screenshot: { maxLongSide: 1568, maxPixels: 1_150_000 }, ax: { maxNodes: 800, maxDepth: 40, maxTextLength: 160 } },
    checkAbort() {},
    out: { text: (t) => printed.push(t) },
    backend: {
      async request(method) {
        if (method === "windows") return [{ index: 0, windowId: 7, frame: [0, 0, 200, 300], scale: 2, title: state.title, focused: true }];
        if (method === "axTree") {
          return {
            window: { title: state.title, windowId: 7 },
            nodes: [
              { i: 0, d: 0, role: "AXWindow", title: state.title, frame: [0, 0, 200, 300] },
              { i: 1, d: 1, role: "AXStaticText", desc: "Edit field", value: state.value, frame: [10, 10, 100, 20] },
            ],
          };
        }
        throw new Error(`unexpected ${method}`);
      },
    },
  };
  return { app: new App(ctx, { name: "Calc", pid: 1 }), state, printed };
}

test("a silent read does not move the diff baseline", async () => {
  const { app, state, printed } = fakeApp();
  await app.getAXState();
  state.value = "42";
  await app.getAXState({ emit: false, disableDiffing: true });
  await app.getAXState();
  assert.equal(printed.length, 2);
  assert.match(printed[1], /changes since last read/);
  assert.match(printed[1], /~\t1 text "Edit field" value="42"/);
});

test("a title change or a frames read does not reprint the tree", async () => {
  const { app, state, printed } = fakeApp();
  await app.getAXState();
  state.title = "Calc — 42";
  state.value = "42";
  await app.getAXState();
  assert.match(printed[1], /changes since last read/);
  assert.equal(printed[1].split("\n").length, 3);
  // The first frames read is printed in full; the plain read after it diffs.
  await app.getAXState({ frames: true });
  assert.match(printed[2], /@20,20 200x40/);
  await app.getAXState();
  assert.match(printed[3], /no change/);
});

// A window with 300 groups of two children each (901 elements), so the
// outline folds the children and prints "(+2 inside)" on each group.
function bigApp() {
  const state = { leaf: "a" };
  const printed = [];
  const nodes = () => {
    const list = [{ i: 0, d: 0, role: "AXWindow", title: "Big", frame: [0, 0, 200, 300] }];
    let i = 1;
    for (let g = 0; g < 300; g++) {
      list.push({ i: i++, d: 1, role: "AXGroup", desc: g === 0 ? `group 0 ${state.leaf}` : `group ${g}`, frame: [0, 0, 100, 10] });
      list.push({ i: i++, d: 2, role: "AXButton", desc: `b${g}`, frame: [0, 0, 10, 10] });
      list.push({ i: i++, d: 2, role: "AXStaticText", desc: `t${g}`, value: g === 1 ? state.leaf : "x", frame: [0, 0, 10, 10] });
    }
    return list;
  };
  const ctx = {
    config: { screenshot: { maxLongSide: 1568, maxPixels: 1_150_000 }, ax: { maxNodes: 2000, maxDepth: 40, maxTextLength: 160 } },
    checkAbort() {},
    out: { text: (t) => printed.push(t) },
    backend: {
      async request(method) {
        if (method === "windows") return [{ index: 0, windowId: 7, frame: [0, 0, 200, 300], scale: 2, title: "Big", focused: true }];
        if (method === "axTree") return { window: { title: "Big", windowId: 7 }, nodes: nodes() };
        throw new Error(`unexpected ${method}`);
      },
    },
  };
  return { app: new App(ctx, { name: "Big", pid: 1 }), state, printed };
}

test("getAXState({root}) prints one subtree with its own baseline", async () => {
  const { app, state, printed } = bigApp();
  await app.getAXState();
  assert.match(printed[0], /group 1" \(\+2 inside\)/);
  // group 1 is element 4: children 5 and 6.
  await app.getAXState({ root: 4 });
  const sub = printed[1];
  assert.match(sub, /under element 4/);
  assert.match(sub, /\b4 group "group 1"/);
  assert.match(sub, /\b5 button "b1"/);
  assert.match(sub, /\b6 text "t1"/);
  assert.doesNotMatch(sub, /group 0|group 2|b0"|b2"/);
  await app.getAXState({ root: 4 });
  assert.match(printed[2], /no change/);
  // The leaf changes: the subtree diffs against its own baseline, and a plain
  // read afterwards still diffs against the last full read (not the subtree).
  state.leaf = "b";
  await app.getAXState({ root: 4 });
  assert.match(printed[3], /changes since last read/);
  assert.match(printed[3], /~\t6 text "t1" value="b"/);
  await app.getAXState();
  assert.match(printed[4], /changes since last read/);
  // Only the visible group 0 changed in the outline; the subtree edit was folded away.
  assert.match(printed[4], /~\s*1 group "group 0 b"/);
  assert.doesNotMatch(printed[4], /— under element \d|group 1"/);
  // {full} composes: a subtree under a root prints unfolded.
  await app.getAXState({ root: 0, full: true, disableDiffing: true });
  assert.match(printed[5], /group 299/);
  await assert.rejects(() => app.getAXState({ root: 99999 }), /Call getAXState\(\) again/);
  await assert.rejects(() => app.getAXState({ root: "4" }), /Call getAXState\(\) again/);
});

// An App whose isActive readings the test scripts, to see when a call stops.
function activeApp(readings, apps = [{ name: "Notes", bundleId: "com.apple.Notes", running: true, active: true }]) {
  const stopped = [];
  const logged = [];
  const ctx = {
    config: { ax: {} },
    cell: 1,
    checkAbort() {},
    log: (e) => logged.push(e),
    stop(reason) {
      stopped.push(reason);
      throw new Error(reason);
    },
    out: { text() {} },
    backend: {
      async request(method) {
        if (method === "isActive") return { active: readings.length > 1 ? readings.shift() : readings[0] };
        if (method === "activate") return {};
        if (method === "listApps") return apps;
        throw new Error(`unexpected ${method}`);
      },
    },
  };
  return { app: new App(ctx, { name: "Calc", pid: 1 }), stopped, logged };
}

test("one false isActive reading does not stop the call", async () => {
  const { app, stopped } = activeApp([false, true]);
  await app.activate(); // brings forward, once for this cell
  await app.activate(); // false, then true: carries on
  assert.deepEqual(stopped, []);
});

test("two false isActive readings stop and name the frontmost app", async () => {
  const { app, stopped, logged } = activeApp([false]);
  await app.activate();
  await assert.rejects(() => app.activate(), /switched away from Calc to Notes/);
  assert.match(stopped[0], /^Stopped: the user switched away from Calc to Notes\./);
  assert.equal(logged.at(-1).frontmost, "Notes");
  // A backend that cannot say what is in front still stops.
  const unknown = activeApp([false], []);
  await unknown.app.activate();
  await assert.rejects(() => unknown.app.activate(), /frontmost app unknown/);
});

test("image space round-trips to screen points", () => {
  const limits = { maxLongSide: 1568, maxPixels: 1_150_000 };
  const view = viewFor({ index: 0, frame: [405, 531, 230, 408], scale: 2 }, limits);
  assert.equal(view.scale, 2);
  assert.deepEqual([view.width, view.height], [460, 816]);
  assert.deepEqual(toScreen(view, [230, 408]), [520, 735]);
  assert.deepEqual(toImage(view, [520, 735, 10, 10]), [230, 408, 20, 20]);

  // A large window is scaled down to the pixel budget, and clicks follow.
  const big = viewFor({ index: 0, frame: [0, 25, 2560, 1415], scale: 2 }, limits);
  assert.ok(big.width * big.height <= limits.maxPixels + big.width + big.height);
  const [sx, sy] = toScreen(big, [big.width / 2, big.height / 2]);
  assert.ok(Math.abs(sx - 1280) < 1 && Math.abs(sy - (25 + 1415 / 2)) < 1);
});

test("ui.device binds getApp to that device and keeps handles apart", async () => {
  const { createApi } = await import("../src/api.mjs");
  const calls = [];
  const fake = (platform, pid) => ({
    platform,
    label: platform,
    async request(method, params) {
      calls.push([platform, method, params]);
      if (method === "resolveApp") return { name: "Clock", bundleId: "com.clock", pid, running: true };
      throw new Error(`unexpected ${method}`);
    },
  });
  const host = fake("macos", 42);
  const devices = new Map();
  const ctx = {
    backend: host,
    device: (serial) => devices.get(serial) ?? devices.set(serial, fake("android", "com.clock")).get(serial),
    checkAbort() {},
    log() {},
    out: { text() {} },
  };
  const ui = createApi(ctx);
  const mac = await ui.getApp("Clock");
  const phone = ui.device("emulator-5554");
  const droid = await phone.getApp("Clock");
  assert.equal(mac.platform, "macos");
  assert.equal(droid.platform, "android");
  assert.equal(droid.pid, "com.clock");
  assert.notEqual(mac, droid);
  // The same device hands back the same handle.
  assert.equal(await ui.device("emulator-5554").getApp("Clock"), droid);
  assert.deepEqual(calls.map(([p, m]) => `${p}:${m}`), ["macos:resolveApp", "android:resolveApp", "android:resolveApp"]);
});

test("Android handles use the hidden screen unless told otherwise", async () => {
  const { createApi } = await import("../src/api.mjs");
  const sent = [];
  const device = (hiddenScreen) => ({
    platform: "android",
    label: "Phone",
    info: { hiddenScreen },
    async request(method, params) {
      sent.push(params);
      return { name: params.query, bundleId: params.query, pid: params.query, running: true };
    },
  });
  const make = (dev, config = {}) => createApi({ backend: {}, device: () => dev, config, checkAbort() {}, log() {}, out: { text() {} } });
  const modern = device(true);
  assert.equal((await make(modern).device().getApp("com.a")).screen, "hidden");
  assert.equal((await make(modern).device().getApp("com.b", { foreground: true })).screen, "phone");
  assert.equal((await make(modern, { androidScreen: "phone" }).device().getApp("com.c")).screen, "phone");
  // On Android, foreground also switches a handle that already exists.
  const api = make(modern);
  const first = await api.device().getApp("com.e");
  assert.equal(await api.device().getApp("com.e", { foreground: true }), first);
  assert.equal(first.screen, "phone");
  // A later getApp without the option goes back to the hidden screen.
  assert.equal(await api.device().getApp("com.e"), first);
  assert.equal(first.screen, "hidden");
  assert.equal((await api.device().getApp("com.e", { foreground: false })).screen, "hidden");
  // Before Android 14 there is no hidden screen.
  assert.equal((await make(device(false)).device().getApp("com.d")).screen, "phone");
});

test("device approval asks first for sensitive apps and never blocks outright", async () => {
  const { authorize, authorizeLocked, isAskFirst } = await import("../src/approval.mjs");
  const asked = [];
  const answer = (value) => async (q) => (asked.push(q.detail), value);
  const base = { client: "Agent", device: "Phone", approved: new Set() };
  const cfg = (approval, extra = {}) => ({ approval, allow: [], deny: [], ...extra });

  // allow-all: ordinary apps pass silently; ask-first apps still ask.
  await authorize({ ...base, pkg: "com.example.notes", config: cfg("allow-all"), prompt: answer("deny") });
  assert.equal(asked.length, 0);
  await assert.rejects(authorize({ ...base, pkg: "com.android.vending", config: cfg("allow-all"), prompt: answer("deny") }), { code: "denied" });
  assert.equal(asked.length, 1);
  assert.ok(isAskFirst("com.google.android.apps.messaging"));

  // ask: one prompt per app per session.
  const approved = new Set();
  await authorize({ ...base, approved, pkg: "com.example.maps", config: cfg("ask"), prompt: answer("session") });
  await authorize({ ...base, approved, pkg: "com.example.maps", config: cfg("ask"), prompt: answer("deny") });
  assert.equal(asked.length, 2);

  // allowlist: ordinary apps need `allow`; ask-first apps can still be approved.
  await assert.rejects(authorize({ ...base, pkg: "com.example.x", config: cfg("allowlist"), prompt: answer("session") }), { code: "not_allowed" });
  await authorize({ ...base, pkg: "com.android.settings", config: cfg("allowlist"), prompt: answer("session") });

  // deny wins; allow skips the prompt even for ask-first apps.
  await assert.rejects(authorize({ ...base, pkg: "com.example.y", config: cfg("allow-all", { deny: ["com.example.y"] }) }), { code: "denied" });
  const before = asked.length;
  await authorize({ ...base, pkg: "com.android.vending", config: cfg("ask", { allow: ["com.android.vending"] }), prompt: answer("deny") });
  assert.equal(asked.length, before);

  // No dialog on this host: a coded error that says how to approve.
  await assert.rejects(authorize({ ...base, pkg: "com.example.z", config: cfg("ask"), prompt: async () => null }), { code: "needs_approval" });

  // A locked phone asks once per session.
  const lockApproved = new Set();
  await authorizeLocked({ ...base, approved: lockApproved, prompt: answer("session") });
  await authorizeLocked({ ...base, approved: lockApproved, prompt: answer("deny") });
});

test("app.find, app.nodes and app.text return data and print nothing", async () => {
  const { createApi } = await import("../src/api.mjs");
  const printed = [];
  const nodes = [
    { i: 1, d: 0, role: "AXWindow", title: "Form", frame: [0, 0, 100, 100] },
    { i: 2, d: 1, role: "AXButton", title: "Save", actions: ["AXPress"], frame: [10, 10, 20, 10] },
    { i: 3, d: 1, role: "AXTextField", value: "x".repeat(300), placeholder: "Notes", settable: true, frame: [10, 30, 80, 10] },
    { i: 4, d: 1, role: "AXButton", title: "Cancel", disabled: true, frame: [40, 10, 20, 10] },
  ];
  const backend = {
    platform: "macos",
    async request(method, params) {
      if (method === "resolveApp") return { name: "Form", bundleId: "com.form", pid: 7, running: true };
      if (method === "windows") return [{ index: 0, windowId: 9, title: "Form", frame: [0, 0, 100, 100], scale: 2, focused: true, main: true }];
      if (method === "axTree") return { window: { windowId: 9, title: "Form" }, nodes: nodes.map((n) => (n.value ? { ...n, value: n.value.slice(0, params.maxText) } : n)) };
      throw new Error(`unexpected ${method}`);
    },
  };
  const config = { ax: { maxNodes: 800, maxDepth: 40, maxTextLength: 160 }, screenshot: {} };
  const ui = createApi({ backend, config, checkAbort() {}, log() {}, out: { text: (t) => printed.push(t) } });
  const app = await ui.getApp("Form");
  assert.equal((await app.find({ role: "button", label: "save" })).index, 2);
  assert.equal((await app.find("notes")).index, 3); // a bare string matches placeholder too
  assert.equal((await app.find({ role: "button", disabled: false }, { all: true })).length, 1);
  assert.equal(await app.find({ label: /^Nope$/ }), null);
  const save = (await app.nodes()).find((n) => n.index === 2);
  assert.deepEqual(save.actions, ["press"]);
  assert.equal(save.frame.length, 4);
  assert.equal((await app.text(3)).length, 300);
  assert.deepEqual(printed, []);
  // expect: returns the match, or prints the window and throws.
  assert.equal((await app.expect({ label: "Save" }, { timeout: 0 })).index, 2);
  assert.equal(await app.expect({ label: "Nope" }, { gone: true, timeout: 0 }), true);
  await assert.rejects(app.expect({ role: "button", label: "Delete" }, { timeout: 0 }), /expect failed in Form: an element matching \{role: "button", label: "Delete"\} not found/);
  assert.equal(printed.length, 1); // the read printed on failure
});

test("large trees read as an outline; find still sees every element", async () => {
  const { outlineTree } = await import("../src/axformat.mjs");
  // A window, 30 sections, each with 20 rows; half the sections are below the window.
  const nodes = [{ i: 1, d: 0, role: "AXWindow", frame: [0, 0, 100, 100] }];
  let i = 2;
  for (let s = 0; s < 30; s++) {
    const y = s < 15 ? s * 6 : 200 + s;
    nodes.push({ i: i++, d: 1, role: "AXGroup", title: `Section ${s}`, frame: [0, y, 100, 5] });
    for (let r = 0; r < 20; r++) nodes.push({ i: i++, d: 2, role: "AXStaticText", title: `row ${r}`, frame: [0, y, 100, 5] });
  }
  const small = outlineTree(nodes.slice(0, 100), { limit: 250 });
  assert.equal(small.nodes.length, 100); // under the limit: unchanged
  const big = outlineTree(nodes, { limit: 250, bounds: [0, 0, 100, 100] });
  assert.equal(big.offscreen, 15 * 21);
  // Level by level: the window, the 15 on-screen sections, then rows in
  // order until 250; the rest count on their section.
  assert.equal(big.nodes.length, 250);
  assert.equal(big.deeper, 1 + 15 * 21 - 250);
  assert.equal(big.folded.get(2), undefined); // section 0 shows all its rows
  assert.equal(big.folded.get(2 + 11 * 21), 6); // section 11 shows 14 of 20
  assert.equal(big.folded.get(2 + 14 * 21), 20);
});

test("init connects agents once, keeps backups, and leaves unparseable configs alone", async () => {
  const { planAgents } = await import("../src/agents.mjs");
  const fsm = await import("node:fs");
  const osm = await import("node:os");
  const pathm = await import("node:path");
  const home = fsm.mkdtempSync(pathm.join(osm.tmpdir(), "nostrings-agents-"));
  const only = ["codex", "cursor", "gemini", "opencode"];
  fsm.mkdirSync(pathm.join(home, ".gemini"));
  fsm.writeFileSync(pathm.join(home, ".gemini", "settings.json"), JSON.stringify({ theme: "dark" }));
  const first = planAgents({ home, only });
  assert.deepEqual(first.map((a) => a.status), ["todo", "todo", "todo", "todo"]);
  for (const a of first) a.apply();
  assert.deepEqual(planAgents({ home, only }).map((a) => a.status), ["done", "done", "done", "done"]);
  const gemini = JSON.parse(fsm.readFileSync(pathm.join(home, ".gemini", "settings.json"), "utf8"));
  assert.equal(gemini.theme, "dark");
  assert.ok(gemini.mcpServers.nostrings.args.includes("mcp"));
  assert.ok(fsm.existsSync(pathm.join(home, ".gemini", "settings.json.before-nostrings")));
  const opencode = JSON.parse(fsm.readFileSync(pathm.join(home, ".config", "opencode", "opencode.json"), "utf8"));
  assert.equal(opencode.mcp.nostrings.type, "local");
  assert.match(fsm.readFileSync(pathm.join(home, ".codex", "config.toml"), "utf8"), /^\[mcp_servers\.nostrings\]$/m);
  fsm.writeFileSync(pathm.join(home, ".cursor", "mcp.json"), "{ // a comment\n}");
  assert.equal(planAgents({ home, only: ["cursor"] })[0].status, "manual");
  fsm.rmSync(home, { recursive: true, force: true });
});

test("saved scripts: names are checked, the first line describes, args parse", async () => {
  const fsm = await import("node:fs");
  const osm = await import("node:os");
  const pathm = await import("node:path");
  const home = fsm.mkdtempSync(pathm.join(osm.tmpdir(), "nostrings-scripts-"));
  const before = process.env.NOSTRINGS_HOME;
  process.env.NOSTRINGS_HOME = home;
  try {
    const s = await import("../src/scripts.mjs");
    assert.throws(() => s.saveScript("../evil", "return 1"), /Script names/);
    assert.throws(() => s.saveScript("ok", "  "), /code is the script/);
    s.saveScript("sum", "// old line\nreturn args.a + args.b;", "Adds two numbers");
    assert.deepEqual(s.listScripts(), [{ name: "sum", description: "Adds two numbers" }]);
    assert.equal(s.readScript("sum"), "// Adds two numbers\nreturn args.a + args.b;\n");
    const fn = vm.runInNewContext(s.wrapScript(s.readScript("sum")));
    assert.equal(await fn({ a: 2, b: 40 }), 42);
    assert.throws(() => s.readScript("missing"), /Saved: sum/);
    assert.deepEqual(s.parseArgPairs(["a=2", "b=x", "c=true", "d="]), { a: 2, b: "x", c: true, d: "" });
    assert.deepEqual(s.parseArgPairs(["code=012345", "x= "]), { code: "012345", x: " " });
    assert.deepEqual(s.parseArgPairs(["n=-3.5", "z=02134", "e=1e3", "h=0x10", "q=NaN", "i=Infinity"]),
      { n: -3.5, z: "02134", e: "1e3", h: "0x10", q: "NaN", i: "Infinity" });
    assert.throws(() => s.parseArgPairs(["novalue"]), /key=value/);
  } finally {
    if (before === undefined) delete process.env.NOSTRINGS_HOME;
    else process.env.NOSTRINGS_HOME = before;
    fsm.rmSync(home, { recursive: true, force: true });
  }
});

test("saved scripts: listing skips bad names and tolerates a missing description", async () => {
  const fsm = await import("node:fs");
  const osm = await import("node:os");
  const pathm = await import("node:path");
  const home = fsm.mkdtempSync(pathm.join(osm.tmpdir(), "nostrings-scripts-"));
  const before = process.env.NOSTRINGS_HOME;
  process.env.NOSTRINGS_HOME = home;
  try {
    const s = await import("../src/scripts.mjs");
    const dir = pathm.join(home, "scripts");
    fsm.mkdirSync(dir, { recursive: true });
    fsm.writeFileSync(pathm.join(dir, "plain.js"), "return 1;\n");
    fsm.writeFileSync(pathm.join(dir, "Bad Name.js"), "// nope\nreturn 1;\n");
    fsm.writeFileSync(pathm.join(dir, "notes.txt"), "// not a script\n");
    fsm.writeFileSync(pathm.join(dir, "b.js"), "// Second\n");
    fsm.writeFileSync(pathm.join(dir, "a.js"), "// First\n");
    assert.deepEqual(s.listScripts(), [
      { name: "a", description: "First" },
      { name: "b", description: "Second" },
      { name: "plain", description: "" },
    ]);
  } finally {
    if (before === undefined) delete process.env.NOSTRINGS_HOME;
    else process.env.NOSTRINGS_HOME = before;
    fsm.rmSync(home, { recursive: true, force: true });
  }
});

test("action log lines carry route on success and error code on failure", async () => {
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  await withHome("nostrings-actionlog-", async (home) => {
    const h = await brokerHarness({
      handlers: {
        click: () => ({ route: "fake" }),
        scroll: () => {
          throw Object.assign(new Error("hidden"), { code: "not_visible" });
        },
      },
    });
    const ok = await h.call("host", "click", { pid: 7, x: 1, y: 1 });
    const bad = await h.call("host", "scroll", { pid: 7, x: 1, y: 1, dy: 3 });
    await h.finish();
    assert.equal(ok.error, undefined);
    assert.ok(bad.error, "the failing call still rejects");
    const entries = fsm.readFileSync(pathm.join(home, "actions.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(entries.length, 2);
    assert.equal(entries[0].action, "click");
    assert.equal(entries[0].route, "fake");
    assert.equal("error" in entries[0], false);
    assert.equal(entries[1].action, "scroll");
    assert.equal(entries[1].error, "not_visible");
    assert.equal("route" in entries[1], false);
  });
});

test("ui.log writes one tagged entry, redacts strings, rejects bad values", async () => {
  const { createApi } = await import("../src/api.mjs");
  const lines = [];
  const config = { log: { enabled: true, text: false } };
  const ui = createApi({ backend: {}, config, log: (entry) => lines.push(entry), out: { text() {} }, help: () => "" });
  const cell = (code) => vm.runInNewContext(code, { ui });
  assert.equal(cell('ui.log({a: 1, ok: true, name: "secret", nested: {n: [1, "x"]}})'), undefined);
  assert.deepEqual(lines[0], { source: "script", data: { a: 1, ok: true, name: "[6 chars]", nested: { n: [1, "[1 chars]"] } } });
  config.log.text = true;
  cell('ui.log({ts: "evil", source: "x", s: "hi"})');
  assert.deepEqual(lines[1], { source: "script", data: { ts: "evil", source: "x", s: "hi" } });
  assert.throws(() => cell("ui.log({f() {}})"), /function/);
  assert.throws(() => cell("const o = {}; o.o = o; ui.log(o)"), /cycle/);
  assert.throws(() => cell('ui.log({big: "x".repeat(9000)})'), /limit is 8192/);
  assert.throws(() => cell("ui.log([1])"), /plain object/);
  assert.throws(() => cell("ui.log({d: new Date()})"), /plain objects/);
  assert.equal(lines.length, 2);
});

test("conformance: the reference fake backend passes every check", async () => {
  const { commandBackend, runConformance } = await import("../src/conformance.mjs");
  const pathm = await import("node:path");
  const fake = pathm.join(pathm.dirname(new URL(import.meta.url).pathname), "fake-backend.mjs");
  const backend = commandBackend(`"${process.execPath}" "${fake}"`);
  try {
    const results = await runConformance(backend, { app: "Fake", input: true });
    assert.deepEqual(results.filter((r) => !r.ok), []);
    assert.equal(results.length, 14);
  } finally {
    backend.close();
  }
});

test("setup keeps waiting through a helper quit and restarts a helper stuck on the old answer", async () => {
  const { waitForPermission } = await import("../src/permissions.mjs");
  // "Quit & Reopen": one request fails, the next sees the grant.
  let calls = 0;
  const quitting = { close() {}, async request() { calls += 1; if (calls === 1) throw new Error("Nostrings Helper disconnected"); return { accessibility: true }; } };
  assert.equal(await waitForPermission(quitting, (p) => p.accessibility, { pollMs: 1, restart: async () => {} }), true);
  // "Later": the running helper says no until it is restarted.
  let fresh = false;
  let restarts = 0;
  const stale = { close() {}, async request() { return { accessibility: fresh }; } };
  const ok = await waitForPermission(stale, (p) => p.accessibility, { pollMs: 1, restartMs: 5, restart: async () => { restarts += 1; fresh = true; } });
  assert.equal(ok, true);
  assert.equal(restarts, 1);
  // Never granted: gives up.
  assert.equal(await waitForPermission(stale, () => false, { minutes: 0.0005, pollMs: 1, restartMs: 5, restart: async () => {} }), false);
});

test("repeat OCR prints only new or moved text and counts what is gone", async () => {
  const { ocrDiff } = await import("../src/api.mjs");
  const a = ['"Name" @10,10 40x12', '"MRN" @10,30 30x12', '"Save" @200,300 40x16'];
  assert.match(ocrDiff("H", a, a), /— no change\.$/);
  const b = ['"Name" @10,10 40x12', '"MRN 12345" @10,30 70x12', '"Save" @200,300 40x16'];
  const d = ocrDiff("H", a, b);
  assert.match(d, /\+ "MRN 12345"/);
  assert.match(d, /2 unchanged not shown, 1 gone/);
  assert.doesNotMatch(d, /"Name"/);
});

test("OCR diff: a scroll collapses to one shift line; jitter and plain edits behave", async () => {
  const { ocrDiff } = await import("../src/api.mjs");
  const item = (t, x, y) => `${JSON.stringify(t)} @${x},${y} 40x12`;
  const id = (r, c) => `R${String(r).padStart(2, "0")}C${String(c).padStart(2, "0")}`;
  const grid = (from, to, dy = 0) => {
    const out = [item("File Edit View", 10, 8)];
    for (let r = from; r <= to; r++) for (let c = 1; c <= 14; c++) out.push(item(id(r, c), 46 + 68 * (c - 1), 218 + 15 * (r - from) + dy));
    return out;
  };
  const before = grid(1, 27);
  const after = grid(6, 33);
  const d = ocrDiff("H", before, after);
  const printed = d.split("\n").slice(1);
  assert.equal(printed.filter((l) => l.startsWith("scrolled:")).length, 1);
  assert.match(d, /scrolled: 308 lines moved up 75px/);
  assert.equal(printed.filter((l) => l.startsWith("+ ")).length, 84);
  assert.ok(printed.filter((l) => l.startsWith("+ ")).every((l) => /R(2[89]|3[0-3])C/.test(l)));
  assert.doesNotMatch(d, /R10C05/);
  assert.match(d, /1 unchanged not shown, 308 shifted/);
  // Two texts read differently after the scroll print as new; the rest collapses.
  const noisy = after.map((l) => l.replace("R10C05", "R1OC05").replace("R12C03", "R12CO3"));
  const d2 = ocrDiff("H", before, noisy);
  assert.match(d2, /\+ "R1OC05"/);
  assert.match(d2, /\+ "R12CO3"/);
  assert.match(d2, /scrolled: 306 lines moved up 75px/);
  assert.doesNotMatch(d2, /"R10C04"/);
  // 2 px of jitter on a static screen is no change.
  const bar = [item("Edit", 38, 48), item("Save", 200, 300)];
  assert.match(ocrDiff("H", bar, [item("Edit", 36, 48), item("Save", 200, 301)]), /— no change\.$/);
  // A label that changes with nothing moving prints just that label.
  const ui = [item("OK", 10, 10), item("Cancel", 60, 10), item("Help", 120, 10)];
  const d3 = ocrDiff("H", ui, [item("OK", 10, 10), item("Cancel", 60, 10), item("Support", 120, 10)]);
  assert.match(d3, /\+ "Support"/);
  assert.doesNotMatch(d3, /scrolled|"OK"|"Cancel"/);
});

test("cell realm: no fetch, Buffer, URL or string eval; globalThis.constructor is not the host Function", async () => {
  const context = createCellContext({ setTimeout, TextEncoder, console: {} });
  const run = (code) => vm.runInContext(transformCell(code), context);
  assert.equal(await run("typeof fetch"), "undefined");
  assert.equal(await run("typeof Buffer"), "undefined");
  assert.equal(await run("typeof URL"), "undefined");
  // The global's constructor, if any, belongs to the cell realm, not the host.
  assert.notEqual(await run("globalThis.constructor?.constructor"), Function);
  assert.notEqual(await run("globalThis.constructor"), Object);
  assert.equal(await run("typeof process"), "undefined");
  assert.equal(await run("btoa('hi')"), "aGk=");
  assert.equal(await run("atob('aGk=')"), "hi");
  await assert.rejects(run('eval("1")'), /code generation|EvalError/i);
  await assert.rejects(run('new Function("return 1")'), /code generation|EvalError/i);
  await assert.rejects(run('(function () {}).constructor("return 1")'), /code generation|EvalError/i);
  await run("const keep = 5");
  assert.equal(await run("keep + 1"), 6);
});

// --- Runner isolation (ns-iz9). Cells run in a no-privilege runner process;
// the broker in the host process holds the backends. These start the real
// runner, with fake backends, and never touch the GUI.

const DENIED = ["ERR_ACCESS_DENIED", "EPERM", "EACCES"];

async function withHome(prefix, fn) {
  const fsm = await import("node:fs");
  const osm = await import("node:os");
  const pathm = await import("node:path");
  const home = fsm.mkdtempSync(pathm.join(osm.tmpdir(), prefix));
  const before = process.env.NOSTRINGS_HOME;
  process.env.NOSTRINGS_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (before === undefined) delete process.env.NOSTRINGS_HOME;
    else process.env.NOSTRINGS_HOME = before;
    fsm.rmSync(home, { recursive: true, force: true });
  }
}

async function fakeHost(handlers = {}) {
  const { EventEmitter } = await import("node:events");
  const calls = [];
  return Object.assign(new EventEmitter(), {
    platform: "macos",
    calls,
    async request(method, params) {
      calls.push([method, params]);
      if (handlers[method]) return handlers[method](params);
      if (method === "listApps") return [{ name: "Fake", bundleId: "dev.nostrings.fake", pid: 4242, running: true }];
      if (method === "resolveApp") return { name: "Fake", bundleId: "dev.nostrings.fake", pid: 4242, running: true, path: "/Applications/Fake.app" };
      throw Object.assign(new Error(`fake host: unexpected ${method}`), { code: "bad_request" });
    },
    close() {},
  });
}

test("runner: a cell that escapes vm still cannot write files, connect, start processes or read the environment", async () => {
  const fsm = await import("node:fs");
  const osm = await import("node:os");
  const pathm = await import("node:path");
  const net = await import("node:net");
  const http = await import("node:http");
  const { Session } = await import("../src/session.mjs");
  await withHome("nostrings-iso-", async (home) => {
    const sock = pathm.join(osm.tmpdir(), `ns-${process.pid}.sock`);
    fsm.rmSync(sock, { force: true });
    const unixServer = net.createServer((c) => c.end());
    await new Promise((r) => unixServer.listen(sock, r));
    const httpServer = http.createServer((q, r) => r.end("ok"));
    await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
    const port = httpServer.address().port;
    // Positive controls: from this (unrestricted) process both connect.
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "ok");
    await new Promise((resolve, reject) => {
      const c = net.connect(sock);
      c.once("connect", () => {
        c.destroy();
        resolve();
      });
      c.once("error", reject);
    });
    process.env.NOSTRINGS_TEST_SENTINEL = "visible";
    const target = pathm.join(home, "escaped-write.txt");
    // A file in the user's home, outside src/: the runner must not read it.
    const secretDir = fsm.mkdtempSync(pathm.join(osm.homedir(), ".nostrings-test-"));
    const secret = pathm.join(secretDir, "secret.txt");
    fsm.writeFileSync(secret, "do not read");
    const { startRunner } = await import("../src/isolation.mjs");
    // The default runner, and on macOS Seatbelt alone (no --permission), so a
    // Seatbelt regression is not hidden behind Node's checks on Node 25+.
    const variants = [{ label: "default", start: () => startRunner() }];
    if (process.platform === "darwin") variants.push({ label: "seatbelt only", start: () => startRunner({ filter: (c) => c.seatbelt && !c.permission }) });
    let session;
    try {
     for (const variant of variants) {
      session = new Session({ client: "unit", start: variant.start, brokerOptions: { host: await fakeHost() } });
      const code = `
        const p = setTimeout.constructor("return process")();
        const g = setTimeout.constructor("return globalThis")();
        const load = p.getBuiltinModule;
        const r = { escaped: typeof p.pid, hasLoader: typeof load };
        const code = (e) => e?.cause?.code ?? e?.code ?? String(e);
        if (load) {
          const fs = load("node:fs"), cp = load("node:child_process"), net = load("node:net");
          try { fs.writeFileSync(${JSON.stringify(target)}, "x"); r.write = "wrote" } catch (e) { r.write = code(e) }
          try { cp.execFileSync("/bin/echo", ["hi"]); r.child = "ran" } catch (e) { r.child = code(e) }
          try { fs.readFileSync(${JSON.stringify(secret)}, "utf8"); r.read = "read" } catch (e) { r.read = code(e) }
          const connect = (o) => new g.Promise((res) => { try { const s = net.connect(o); s.on("connect", () => { s.destroy(); res("connected") }); s.on("error", (e) => res(code(e))) } catch (e) { res(code(e)) } });
          r.unix = await connect({ path: ${JSON.stringify(sock)} });
          r.tcp = await connect({ host: "127.0.0.1", port: ${port} });
        }
        try { await g.fetch("http://127.0.0.1:${port}/"); r.fetch = "fetched" } catch (e) { r.fetch = code(e) }
        r.env = p.env.NOSTRINGS_TEST_SENTINEL ?? null;
        try { p.kill(p.ppid, 0); r.signal = "allowed" } catch (e) { r.signal = code(e) }
        JSON.stringify(r)`;
      const result = await session.run(code, { timeoutMs: 20_000 });
      assert.ok(result.ok, `${variant.label}: ${JSON.stringify(result)}`);
      const r = JSON.parse(result.content.at(-1).text);
      const iso = session.isolation;
      // The escape itself works: vm is not the boundary, the process is.
      assert.equal(r.escaped, "number");
      if (r.hasLoader === "function") assert.ok(DENIED.includes(r.read), `${variant.label}: read outside src/: ${r.read}`);
      if (variant.label === "seatbelt only") {
        assert.equal(iso.permission, null);
        for (const key of ["write", "child", "read", "unix", "tcp", "fetch", "signal"]) assert.equal(r[key], "EPERM", `seatbelt only: ${key} = ${r[key]}`);
      }
      assert.equal(r.env, null, "the runner gets an empty environment");
      assert.ok(iso.fsWriteDenied && iso.childDenied, JSON.stringify(iso));
      if (r.hasLoader === "function") {
        assert.ok(DENIED.includes(r.write), `file write: ${r.write}`);
        assert.equal(fsm.existsSync(target), false);
        assert.ok(DENIED.includes(r.child), `child process: ${r.child}`);
        if (iso.networkDenied) {
          assert.ok(DENIED.includes(r.unix), `unix socket: ${r.unix}`);
          assert.ok(DENIED.includes(r.tcp), `tcp: ${r.tcp}`);
          assert.ok(DENIED.includes(r.fetch), `fetch: ${r.fetch}`);
        }
      }
      // (Node 20 before 20.16 has no process.getBuiltinModule; the runner's
      // own probe, checked through `iso`, covers the same ground.)
      const [major] = process.versions.node.split(".").map(Number);
      if (process.platform === "darwin") {
        assert.equal(iso.seatbelt, true, `Seatbelt not applied: ${iso.warnings.join("; ")}`);
        assert.equal(r.signal, "EPERM", "Seatbelt denies signals to other processes");
        assert.equal(iso.networkDenied, true);
      } else if (major >= 25) {
        assert.equal(iso.networkDenied, true);
      } else {
        // Linux, Node < 25: Node cannot deny the network; the session says so.
        assert.ok(iso.networkDenied || iso.warnings.some((w) => /not network-isolated/.test(w)), JSON.stringify(iso));
      }
      session.reset();
     }
    } finally {
      delete process.env.NOSTRINGS_TEST_SENTINEL;
      session?.reset();
      fsm.rmSync(secretDir, { recursive: true, force: true });
      unixServer.close();
      httpServer.close();
      fsm.rmSync(sock, { force: true });
    }
  });
});

test("runner: after Escape the host refuses the cell's requests, even forged ones", async () => {
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  const { Session } = await import("../src/session.mjs");
  await withHome("nostrings-stop-", async (home) => {
    const host = await fakeHost();
    const session = new Session({ client: "unit", brokerOptions: { host } });
    try {
      const listed = () => host.calls.filter(([m]) => m === "listApps").length;
      const pending = session.run(
        `await ui.listApps({ emit: false });
         await sleep(500);
         // A taken-over runner writes a request straight to the pipe.
         const p = setTimeout.constructor("return process")();
         const fs = p.getBuiltinModule?.("node:fs");
         fs?.writeSync(1, JSON.stringify({ op: "call", rid: 999999, target: "host", method: "listApps", params: {} }) + "\\n");
         await sleep(200);
         await ui.listApps({ emit: false });
         "not reached"`,
        { timeoutMs: 20_000 },
      );
      for (let i = 0; i < 200 && listed() === 0; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(listed(), 1);
      host.emit("escape");
      const result = await pending;
      assert.equal(result.ok, false);
      assert.match(result.content.at(-1).text, /Stopped: the user pressed Escape/);
      assert.equal(listed(), 1, "no request reached the backend after the stop");
      assert.match(fsm.readFileSync(pathm.join(home, "actions.log"), "utf8"), /"action":"stopped"/);
      // The stop lasts for that cell only.
      const next = await session.run("(await ui.listApps({ emit: false })).length", { timeoutMs: 20_000 });
      assert.deepEqual(next, { ok: true, content: [{ type: "text", text: "1" }] });
    } finally {
      session.reset();
    }
  });
});

test("runner: a shown screenshot survives many silent captures in the same call", async () => {
  const { Session } = await import("../src/session.mjs");
  await withHome("nostrings-shots-", async () => {
    let n = 0;
    const host = await fakeHost({
      windows: () => [{ index: 0, title: "W", frame: [0, 0, 400, 300], scale: 2, focused: true, main: true, minimized: false, windowId: 1 }],
      screenshot: ({ width, height }) => ({ data: Buffer.from(`shot-${n++}`).toString("base64"), width, height, mimeType: "image/png" }),
    });
    const session = new Session({ client: "unit", brokerOptions: { host } });
    try {
      const result = await session.run(
        `const app = await ui.getApp("Fake");
         await app.getScreenshot();
         for (let i = 0; i < 40; i++) await app.getScreenshot({ emit: false });
         "done"`,
        { timeoutMs: 20_000 },
      );
      assert.ok(result.ok, JSON.stringify(result).slice(0, 500));
      const images = result.content.filter((c) => c.type === "image");
      assert.equal(images.length, 1);
      assert.equal(Buffer.from(images[0].data, "base64").toString(), "shot-0");
    } finally {
      session.reset();
    }
  });
});

test("broker: typed text is logged as a length unless log.text is on", async () => {
  const { EventEmitter } = await import("node:events");
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  const { Broker } = await import("../src/broker.mjs");
  await withHome("nostrings-redact-", async (home) => {
    const SECRET = "hunter2-sentinel";
    const sent = [];
    const child = Object.assign(new EventEmitter(), { stdin: { write: (line) => sent.push(JSON.parse(line)) }, kill() {} });
    const lines = new EventEmitter();
    const ok = () => ({});
    const host = await fakeHost({ type: ok, setValue: ok, pasteStash: ok, systemKeys: ok, clipboard: ok });
    const device = Object.assign(new EventEmitter(), { label: "Phone", info: null, request: async () => ({}), close() {} });
    const broker = new Broker({ runner: { child, lines, isolation: { warnings: [] }, stderr: () => "" }, client: "unit", host, createDevice: () => device });
    const done = broker.eval("1");
    await new Promise((r) => setTimeout(r, 0));
    const requests = [
      ["host", "type", { pid: 1, text: SECRET }],
      ["host", "setValue", { pid: 1, index: 3, value: SECRET }],
      ["host", "pasteStash", { pid: 1, op: "stash", text: SECRET }],
      ["host", "systemKeys", { text: SECRET }],
      ["host", "clipboard", { op: "write", text: SECRET }],
      ["device", "type", { pid: "com.example", text: SECRET }],
      ["device", "setValue", { pid: "com.example", index: 2, value: SECRET }],
      ["nostrings", "scriptLog", { data: { note: SECRET, n: 3 } }],
    ];
    let rid = 0;
    for (const [target, method, params] of requests) lines.emit("message", { op: "call", rid: ++rid, target, method, params });
    for (let i = 0; i < 200 && sent.filter((m) => m.op === "reply").length < requests.length; i++) await new Promise((r) => setTimeout(r, 5));
    const evalMsg = sent.find((m) => m.op === "eval");
    lines.emit("message", { op: "done", id: evalMsg.id, ok: true, content: [] });
    await done;
    broker.kill();
    const log = fsm.readFileSync(pathm.join(home, "actions.log"), "utf8");
    assert.equal(log.trim().split("\n").length, requests.length);
    assert.doesNotMatch(log, /hunter2/);
    assert.match(log, new RegExp(`"length":${SECRET.length}`));
    assert.match(log, /"source":"script","data":\{"note":"\[16 chars\]","n":3\}/);
  });
});

test("broker: forged runner messages are refused and approval text is the host's own", async () => {
  const { EventEmitter } = await import("node:events");
  const { Broker } = await import("../src/broker.mjs");
  await withHome("nostrings-broker-", async () => {
    const sent = [];
    const child = Object.assign(new EventEmitter(), { stdin: { write: (line) => sent.push(JSON.parse(line)) }, kill() {} });
    const lines = new EventEmitter();
    const host = await fakeHost({
      approveSurface: () => ({}),
      permissions: () => ({ accessibility: true }),
      launch: () => ({ name: "TextEdit", bundleId: "com.apple.TextEdit", pid: 77, running: true }),
      resolveApp: () => ({ name: "TextEdit", bundleId: "com.apple.TextEdit", pid: 0, running: false, path: "/System/Applications/TextEdit.app" }),
    });
    const deviceCalls = [];
    const device = Object.assign(new EventEmitter(), {
      label: "Phone",
      info: null,
      async request(m, p) {
        deviceCalls.push([m, p]);
        return {};
      },
      close() {},
    });
    const broker = new Broker({ runner: { child, lines, isolation: { warnings: [] }, stderr: () => "" }, client: "unit", host, createDevice: () => device });
    assert.equal(sent[0].op, "init");
    let rid = 0;
    const call = async (target, method, params = {}, extra = {}) => {
      const id = ++rid;
      lines.emit("message", { op: "call", rid: id, target, method, params, ...extra });
      for (let i = 0; i < 200; i++) {
        const reply = sent.find((m) => m.op === "reply" && m.rid === id);
        if (reply) return reply;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`no reply to ${method}`);
    };
    // Nothing is honored between cells.
    assert.equal((await call("host", "listApps")).error.code, "stopped");
    const done = broker.eval("1", { title: "t" });
    await new Promise((r) => setTimeout(r, 0));
    const evalMsg = sent.find((m) => m.op === "eval");
    assert.ok(evalMsg && evalMsg.config && Array.isArray(evalMsg.scripts));
    // Unknown and reserved methods.
    for (const [target, method] of [["host", "evil"], ["host", "hello"], ["device", "hello"], ["device", "_tapDisplay"], ["nostrings", "writeFile"], ["elsewhere", "listApps"]]) {
      assert.equal((await call(target, method)).error?.code, "bad_request", `${target}.${method}`);
    }
    assert.equal(host.calls.length, 0);
    assert.equal(deviceCalls.length, 0);
    // Dialog text comes from the host's table, not the request.
    await call("host", "approveSurface", { key: "macos:notifications", name: "a harmless widget", reason: "Trust me." });
    assert.deepEqual(host.calls.at(-1), ["approveSurface", { key: "macos:notifications", name: "your notifications", reason: "Notifications can show messages and one-time codes." }]);
    assert.equal((await call("host", "approveSurface", { key: "macos:screen", name: "x" })).error.code, "bad_request");
    // launch approves `bundleId` and opens `path`: both come from the helper's own resolution.
    await call("host", "launch", { bundleId: "com.apple.TextEdit", path: "/System/Applications/Utilities/Terminal.app", name: "TextEdit" });
    assert.deepEqual(host.calls.at(-1), ["launch", { bundleId: "com.apple.TextEdit", path: "/System/Applications/TextEdit.app", name: "TextEdit", activate: false }]);
    assert.equal((await call("host", "launch", { path: "/System/Applications/Utilities/Terminal.app" })).error.code, "bad_request");
    // No privacy prompts from scripts.
    await call("host", "permissions", { ask: "accessibility" });
    assert.deepEqual(host.calls.at(-1), ["permissions", {}]);
    // open -b only for an app approved in this session.
    assert.equal((await call("host", "_bringForward", { pid: 77 })).error.code, process.platform === "darwin" ? "denied" : "bad_request");
    // A bad device serial is refused before any backend exists.
    assert.equal((await call("device", "listApps", {}, { serial: "../../x y" })).error.code, "bad_request");
    // A stop holds for the rest of the cell.
    lines.emit("message", { op: "stop", reason: "Stopped: the user switched away." });
    const before = host.calls.length;
    const refused = await call("host", "listApps");
    assert.equal(refused.error.code, "stopped");
    assert.match(refused.error.message, /switched away/);
    assert.equal(host.calls.length, before);
    assert.ok(sent.some((m) => m.op === "abort"));
    // A done for another cell is ignored; the right one ends the cell, and
    // content is checked (unknown images and items are dropped).
    lines.emit("message", { op: "done", id: 999, ok: true, content: [{ type: "text", text: "forged" }] });
    lines.emit("message", { op: "done", id: evalMsg.id, ok: true, content: [{ type: "text", text: "real" }, { type: "image", ref: "img999" }, { type: "bogus" }] });
    // The cell was stopped, so it failed and says why, whatever the runner's `done` claims.
    assert.deepEqual(await done, { ok: false, content: [{ type: "text", text: "real\nStopped: the user switched away." }] });
    // The next cell starts clean; a timeout abort latches too.
    const second = broker.eval("2");
    await new Promise((r) => setTimeout(r, 0));
    const evalTwo = sent.filter((m) => m.op === "eval")[1];
    assert.ok((await call("host", "listApps")).result);
    broker.abort("Stopped: the script ran longer than 10 ms.");
    assert.equal((await call("host", "listApps")).error.code, "stopped");
    lines.emit("message", { op: "done", id: evalTwo.id, ok: false, content: [] });
    await second;
    broker.kill();
  });
});

// A Broker on a fake runner, with a cell running. `call` sends a request and
// resolves with its reply.
async function brokerHarness({ handlers = {}, openBundle } = {}) {
  const { EventEmitter } = await import("node:events");
  const { Broker } = await import("../src/broker.mjs");
  const sent = [];
  const child = Object.assign(new EventEmitter(), { stdin: { write: (line) => sent.push(JSON.parse(line)) }, kill() {} });
  const lines = new EventEmitter();
  const host = await fakeHost(handlers);
  const broker = new Broker({ runner: { child, lines, isolation: { warnings: [] }, stderr: () => "" }, client: "unit", host, openBundle });
  const done = broker.eval("1");
  await new Promise((r) => setTimeout(r, 0));
  const evalMsg = sent.find((m) => m.op === "eval");
  let rid = 0;
  const send = (target, method, params = {}) => {
    const id = ++rid;
    lines.emit("message", { op: "call", rid: id, target, method, params });
    return id;
  };
  const reply = async (id) => {
    for (let i = 0; i < 400; i++) {
      const found = sent.find((m) => m.op === "reply" && m.rid === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no reply to ${id}`);
  };
  const call = (target, method, params) => reply(send(target, method, params));
  const finish = async () => {
    lines.emit("message", { op: "done", id: evalMsg.id, ok: true, content: [] });
    const result = await done;
    broker.kill();
    return result;
  };
  return { broker, host, sent, send, reply, call, finish };
}

test("broker: one request at a time; Escape refuses the queued ones", async () => {
  await withHome("nostrings-queue-", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const h = await brokerHarness({ handlers: { click: () => gate.then(() => ({ route: "fake" })) } });
    const first = h.send("host", "click", { pid: 1, x: 1, y: 1 });
    const queued = [h.send("host", "click", { pid: 1, x: 2, y: 2 }), h.send("host", "listApps")];
    await new Promise((r) => setTimeout(r, 20));
    // Only the first reached the backend; the rest wait their turn.
    assert.equal(h.host.calls.length, 1);
    h.host.emit("escape");
    release();
    assert.ok((await h.reply(first)).result, "the call already in the helper finishes");
    for (const id of queued) assert.equal((await h.reply(id)).error.code, "stopped");
    assert.equal(h.host.calls.length, 1);
    const result = await h.finish();
    assert.equal(result.ok, false);
    assert.match(result.content.at(-1).text, /Escape/);
  });
});

test("broker: queue cap, prompts, clamps, log fields and open -b gating", async () => {
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  const { trackPrompt } = await import("../src/approval.mjs");
  await withHome("nostrings-limits-", async (home) => {
    let release;
    const gate = new Promise((r) => (release = r));
    const opened = [];
    const h = await brokerHarness({
      handlers: { click: (p) => (p.x === -5 ? gate : {}), allWindows: () => [], type: () => ({}) },
      openBundle: async (id) => opened.push(id),
    });
    // At most 64 waiting; beyond that, refused.
    const blocker = h.send("host", "click", { pid: 1, x: -5, y: 0 });
    const waiting = Array.from({ length: 64 }, () => h.send("host", "listApps"));
    assert.equal((await h.reply(h.send("host", "listApps"))).error.code, "busy");
    release();
    await h.reply(blocker);
    for (const id of waiting) assert.ok((await h.reply(id)).result);
    // While an approval dialog is open, input is refused and reads are not.
    let answer;
    const prompt = trackPrompt(new Promise((r) => (answer = r)));
    assert.equal((await h.call("host", "click", { pid: 1, x: 1, y: 1 })).error.code, "busy");
    assert.ok((await h.call("host", "listApps")).result);
    answer("deny");
    await prompt;
    // Numbers: clamped, and out-of-range ones refused.
    await h.call("host", "click", { pid: 1, x: 1, y: 1, count: 50, holdMs: 1e6 });
    assert.deepEqual(h.host.calls.at(-1), ["click", { pid: 1, x: 1, y: 1, count: 3, holdMs: 10_000 }]);
    assert.equal((await h.call("host", "click", { pid: 1, x: 1e12, y: 1 })).error.code, "bad_request");
    assert.equal((await h.call("host", "click", { pid: 1, x: 1, y: 1, count: -1 })).error.code, "bad_request");
    // Request params cannot overwrite the log's own fields.
    await h.call("host", "click", { pid: 1, x: 3, y: 3, ts: "1999", client: "forged", step: "forged", app: "forged", action: "forged" });
    const entries = fsm.readFileSync(pathm.join(home, "actions.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const typed = entries.find((e) => e.action === "click" && e.params.x === 3);
    assert.equal(typed.client, "unit");
    assert.notEqual(typed.ts, "1999");
    assert.equal(typed.app, "pid:1");
    assert.equal(typed.params.client, "forged");
    // open -b: not after a surface method that happened to carry the pid,
    // only after a pid-gated one.
    if (process.platform === "darwin") {
      await h.call("host", "allWindows", { pid: 4242 });
      assert.equal((await h.call("host", "_bringForward", { pid: 4242 })).error.code, "denied");
      await h.call("host", "listApps");
      await h.call("host", "click", { pid: 4242, x: 1, y: 1 });
      assert.ok((await h.call("host", "_bringForward", { pid: 4242 })).result);
      assert.deepEqual(opened, ["dev.nostrings.fake"]);
    }
    await h.finish();
  });
});

test("broker: one log line per request when it ends, with route or error, and late focus restores", async () => {
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  await withHome("nostrings-route-", async (home) => {
    const h = await brokerHarness({
      handlers: {
        click: () => ({ route: "background", focusRestored: true }),
        scroll: () => {
          throw Object.assign(new Error("nope"), { code: "background_unavailable" });
        },
        windows: () => ({ windows: [], lateFocusRestored: { afterMs: 900, restored: true } }),
      },
    });
    await h.call("host", "click", { pid: 7, x: 1, y: 1 });
    await h.call("host", "scroll", { pid: 7, x: 1, y: 1, dy: 3 });
    await h.call("host", "windows", { pid: 7 });
    await h.finish();
    const entries = fsm.readFileSync(pathm.join(home, "actions.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(entries.map((e) => [e.action, e.route ?? e.error ?? null]), [
      ["click", "background (focus restored)"],
      ["scroll", "background_unavailable"],
      ["focus", null],
    ]);
    assert.equal(entries[2].late, true);
    assert.equal(entries[2].afterMs, 900);
  });
});

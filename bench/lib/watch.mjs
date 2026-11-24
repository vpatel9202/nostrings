// Host-side watch on the user's desktop during a run: which app is frontmost
// and where the mouse cursor is. It never goes through the tool under test.
//
// Each sample is one `osascript -l JavaScript` call that reads the frontmost
// app's bundle id from NSWorkspace and the cursor from NSEvent.mouseLocation
// (screen points, origin bottom-left). Neither read needs a privacy permission.
import { execFile } from "node:child_process";

const SAMPLE_JS = `ObjC.import("AppKit");
const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
const p = $.NSEvent.mouseLocation;
JSON.stringify({ app: app ? ObjC.unwrap(app.bundleIdentifier) || ObjC.unwrap(app.localizedName) : null, x: p.x, y: p.y });`;

function sampleOnce() {
  return new Promise((resolve) => {
    execFile("osascript", ["-l", "JavaScript", "-e", SAMPLE_JS], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve(null);
      }
    });
  });
}

// Pure. `samples` are {app, x, y} in time order, the first taken just before
// the agent starts.
// - focusSteals: how many times the frontmost app changed away from the app
//   that was in front at the start (each departure counts once, so leaving,
//   coming back, and leaving again is two).
// - cursorMoved: the cursor ended up, or passed through, more than
//   `tolerancePx` points from where it started. cursorMaxPx is that distance.
// Returns null when nothing could be sampled.
export function foldWatch(samples, { tolerancePx = 2 } = {}) {
  const s = samples.filter(Boolean);
  if (!s.length) return null;
  const home = s[0];
  let focusSteals = 0;
  let away = false;
  let maxPx = 0;
  const apps = new Set([home.app]);
  for (const sample of s.slice(1)) {
    apps.add(sample.app);
    const isAway = sample.app !== home.app;
    if (isAway && !away) focusSteals += 1;
    away = isAway;
    maxPx = Math.max(maxPx, Math.hypot(sample.x - home.x, sample.y - home.y));
  }
  return {
    focusSteals,
    otherApps: [...apps].filter((a) => a !== home.app),
    cursorMoved: maxPx > tolerancePx,
    cursorMaxPx: Math.round(maxPx),
    watchSamples: s.length,
  };
}

// Starts polling; `stop()` takes one last sample and returns foldWatch's result.
// Polling is about 3 per second: a focus steal shorter than that can be missed,
// so the count is a lower bound.
export async function startWatch({ everyMs = 300 } = {}) {
  const samples = [await sampleOnce()];
  let running = true;
  const loop = (async () => {
    while (running) {
      await new Promise((r) => setTimeout(r, everyMs));
      if (!running) break;
      samples.push(await sampleOnce());
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      samples.push(await sampleOnce());
      return foldWatch(samples);
    },
  };
}

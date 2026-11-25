# Attaching nostrings to an agent

nostrings speaks MCP over stdio (`nostrings mcp`) and also has a CLI
(`nostrings run`) for agents that can only run shell commands. Both expose the
same persistent JavaScript session.

The quick way: `nostrings init` finds the agents below that are installed,
shows the exact change for each, and makes it when you say yes. Running it
again skips agents that are already connected, and each file it edits gets a
`.before-nostrings` backup the first time. The sections below are the same
changes by hand.

```bash
npm install -g nostrings
nostrings init      # helper and permissions (Mac), agents, a short test
```

Or step by step:

```bash
nostrings setup     # macOS: builds Nostrings Helper.app and walks through permissions
nostrings doctor    # everything should say ok
nostrings smoke     # optional: a real end-to-end check on Calculator
```

If `nostrings` is not on your PATH (for example, under a version manager), use
the absolute path from `which nostrings`, or run it as
`node /path/to/nostrings/bin/nostrings.mjs mcp`.

The MCP server exposes two tools: `js` (run a script) and `js_reset` (drop the
session). Most agents name them `<server>__js` or `mcp__<server>__js`.

## Claude Code

```bash
claude mcp add --scope user nostrings -- nostrings mcp
```

Check with `/mcp` in a session. Non-interactive runs (`claude -p`) need the
tool allowed up front, since there is no one to answer a permission prompt:
`claude -p --allowedTools mcp__nostrings__js -- "..."`. Tested 2026-11-24
(Claude Code 2.1.327, with a temporary `--mcp-config` and
`--strict-mcp-config`): it opened Calculator, typed `2+2=`, printed `4` and
exited 0. To teach Claude the loop, copy the skill:

```bash
mkdir -p ~/.claude/skills && cp -R "$(npm root -g)/nostrings/skills/nostrings" ~/.claude/skills/
```

## Grok CLI

Add to `~/.grok/config.toml`, then start a new session:

```toml
[mcp_servers.nostrings]
command = "nostrings"
args = ["mcp"]
enabled = true
```

Verify with `grok mcp doctor nostrings`. This config, and the OpenCode and
Codex ones below, follow each client's documented MCP format but have not been
exercised end to end. Skill:

```bash
mkdir -p ~/.grok/skills && cp -R "$(npm root -g)/nostrings/skills/nostrings" ~/.grok/skills/
```

## OpenCode

Add to `opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "nostrings": {
      "type": "local",
      "command": ["nostrings", "mcp"],
      "enabled": true
    }
  }
}
```

## Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.nostrings]
command = "nostrings"
args = ["mcp"]
```

## Gemini CLI, Cursor, and other MCP clients

Most clients accept the common `mcpServers` JSON shape:

```json
{
  "mcpServers": {
    "nostrings": { "command": "nostrings", "args": ["mcp"] }
  }
}
```

## Agents without MCP: the CLI

`nostrings run` sends a script to a background daemon that keeps the session
alive between calls, so bindings persist exactly as they do over MCP.

```bash
nostrings run 'const calc = await ui.getApp("Calculator"); await calc.typeText("2+2="); await calc.getAXState()'
nostrings run 'await calc.getAXState()'          # calc is still bound
nostrings run -f step.js --title "fill form"     # or from a file, or stdin
nostrings reset                                   # drop the bindings
```

Screenshots are written to `~/.nostrings/screenshots/` and the path is printed,
so an agent that can read image files can look at them. Use `--session name`
to keep separate sessions. The daemon exits after an hour idle
(`daemon.idleMinutes` in the config).

## Approval prompts

The first time a session touches an app, nostrings shows a native dialog:
**Allow for This Session**, **Always Allow**, or **Deny**. "Session" means one
MCP connection or one CLI session. To pre-approve apps without dialogs:

```bash
nostrings allow Calculator TextEdit
nostrings approval allowlist   # never prompt; only allowlisted apps work
```

`nostrings approval allow-all` turns prompts off for every app except the
ask-first ones (terminals, password managers, System Settings, messaging
apps, and a few others), which still ask unless you `nostrings allow` them.
The full list is in [SECURITY.md](../SECURITY.md#ask-first-apps).

## Android phones and emulators

The same session drives Android through `ui.device()`; nothing changes on
the agent's side. On the computer you need `adb` (Android platform-tools) and
a phone with USB or wireless debugging on, or an emulator. Check it:

```bash
nostrings doctor                          # lists each device and probes it
nostrings smoke --android --serial emulator-5554
```

With more than one device connected (a phone shows up twice when both USB and
wireless debugging are on), pass the serial: `ui.device("emulator-5554")`.
On Android 14 and later each app the agent opens runs on its own hidden
screen, so the phone's screen and keyboard stay with you. Approval dialogs
for the phone appear on the computer, with the same `nostrings allow`
settings; apps that can move money, read messages or change settings always
ask first. See [api.md](api.md#android) for the calls, and
[testing.md](testing.md#android-support-matrix) for the devices and versions
that have run.

Several agents can share one phone at a time: each session gets its own
hidden screens, and one app can be open in only one session.

# Security

nostrings lets an AI agent click, type, and read the screen in apps on your
computer. Treat it with the same care as giving someone remote control.

## What protects you

- **Per-app approval.** By default, the first action a session takes in an app
  shows a dialog: Allow for This Session, Always Allow, or Deny. The check runs
  inside Nostrings Helper, the process that holds the macOS permissions, so
  scripts cannot skip it.
- **Ask-first apps.** Nothing is blocked outright: you decide. Apps that can
  run commands, hold secrets, send messages, or change system settings always
  show the dialog, even under `approval: "allow-all"`, unless you add them
  with `nostrings allow` (see the list below). The dialog says why. An agent
  with terminal access could use the GUI to run commands its sandbox would
  not allow, so approve a terminal only when you mean to. Surfaces that are
  not one app (the whole screen, the clipboard, notifications, the Dock and
  menu bar, opening files) are ask first too. An app on the `deny` list is
  refused even if it is also allowed.
- **System-wide keys ask twice.** `ui.pressKey` and `ui.typeText` go to
  whatever app is in front, so they need `macos:system` and that app's
  approval too. Two cases skip the second check because the keys never reach
  that app: system hotkeys (Cmd+Space, Mission Control, screenshots, the app
  switcher, lock screen) and typing while Spotlight's panel is open.
- **Unanswered dialogs deny.** A dialog nobody answers denies after two
  minutes, so an unattended agent cannot wait on it forever. In the dialogs
  nostrings shows for phones, Deny is the default button, and while one is
  open nostrings refuses every action that is not a read.
- **Taking over stops a script.** If a script had to bring an app forward and
  you switch away, the script stops instead of taking focus back. A script
  working in the background keeps running while you use other apps, so switching
  apps does not stop it. With the optional Input Monitoring permission, pressing
  Escape stops any script (nostrings marks its own key events, so its own Escapes
  do not count): every request the script has not yet sent is refused, and
  Nostrings Helper drops the input it still has queued or is running for
  that session, so a long drag or typed string stops partway (a held button
  or key is still released). Stop Running Scripts, a timeout and a closed
  session do the same.
- **Input and captures stay in the approved app.** The helper checks this
  itself, so it holds even for a script that escapes the scripting layer.
  A screenshot request names a window, and it must be one of that app's own
  windows (`not_owned` otherwise). Pointer input on the foreground route
  (click, scroll, drag, move, hover, gestures, file drops) must land on one
  of that app's windows, topmost at that point (`outside_app` otherwise).
  On the background route events are posted to that app's process only.
  Click counts, hold times, scroll lengths and gesture durations are capped.
- **Menu-bar item.** While an agent is connected, Nostrings Helper shows a
  menu-bar item listing each session and its approved apps. Stop Running
  Scripts stops every running script. Revoke Session Approvals clears the
  per-session approvals, so apps must be approved again; it does not touch
  `allow` entries in `config.json`. Quit Nostrings Helper exits the helper; the
  next agent call starts it again.
- **Scripts run in a separate process with no privileges.** Cells run in a
  runner process that holds no connection to the helper or a phone and gets
  an empty environment. Under Node's permission model it can read only
  nostrings' own `src/` and cannot write files or start processes or workers.
  On macOS it also runs in a deny-default Seatbelt sandbox (`sandbox-exec`):
  no network, no Unix sockets (so not the helper's socket, the CLI daemon's,
  or adb's port 5037), no reads outside nostrings' `src/`, node's own install
  and the system's libraries, no file writes, no new processes, no signals to
  other processes. On macOS the sandbox is required: if it cannot apply,
  scripts do not run (see `isolation` below). Everything a script does is a
  request to the host process (the MCP server or CLI daemon), which runs them
  one at a time, accepts only known methods, clamps timing and repeat
  counts, writes the text of every approval dialog itself, refuses requests
  between calls and for the rest of a call after a stop, and writes the
  action log from the requests it forwards. `nostrings doctor` prints which
  layers applied.
- **Action log.** `~/.nostrings/actions.log` has one JSON object per action:
  `ts`, `client` (the agent's name), `step` (the call's title, when given),
  `app`, `action`, and `params`, that request's parameters (for example
  `target`, `index`, or `length`), then `route` or `error` (written when the
  request ends; a late focus restore adds an `action: "focus"` line). The
  host process writes it, not the script's process, and request parameters
  cannot overwrite the other fields. Typed text is recorded as a length
  only, unless you set `"log": {"text": true}`.
- **Local only.** Nothing is sent over the network. The helper listens on a
  Unix socket that only your user can open.

## Ask-first apps

This is the full default list, from `askFirstByDefault` in
`native/macos/NostringsHelper.swift`. Bundle ids are matched case-insensitively.
`nostrings allow <name or bundle id>` skips the dialog for one; `askFirst` in
`config.json` adds more.

| Kind | Bundle ids |
|---|---|
| Terminals | `com.apple.terminal`, `com.googlecode.iterm2`, `com.mitchellh.ghostty`, `dev.warp.warp-stable`, `com.github.wez.wezterm`, `org.alacritty`, `net.kovidgoyal.kitty`, `org.tabby`, `co.zeit.hyper`, `com.cmuxterm.app`, `com.termius.mac` |
| Scripting | `com.apple.scripteditor2`, `com.apple.automator`, `com.apple.shortcuts` |
| System and security prompts | `com.apple.systempreferences`, `com.apple.installer`, `com.apple.securityagent`, `com.apple.coreservices.uiagent`, `com.apple.usernotificationcenter`, `com.apple.appstore` |
| Password managers | `com.apple.keychainaccess`, `com.apple.passwords`, `com.1password.1password`, `com.agilebits.onepassword7`, `com.bitwarden.desktop`, `com.lastpass.lastpassmacdesktop` |
| Messages and calls | `com.apple.mobilesms`, `com.apple.facetime`, `com.apple.mail` |
| Not one app | `macos:screen`, `macos:clipboard`, `macos:notifications`, `macos:system`, `macos:files` |

Order of checks for each app: `deny`, then `allow`, then this list (ask), then
the `approval` mode.

One target is refused: Nostrings Helper itself
(`io.github.vpatel9202.nostrings.helper`). Its windows are the approval
dialogs, and an agent that could press them would approve itself.

## What does not

- Code running as your user can edit `~/.nostrings/config.json` and approve
  apps for itself, or talk to the helper directly. nostrings does not defend
  against malware already running as you.
- `approval: "allow-all"` removes the dialogs for every app that is not ask
  first.
  Use it only when you trust every agent you attach.
- An approved app is approved for everything in it. Allowing a browser lets
  the agent use every site you are signed in to.
- Keys on the foreground route go to whichever app is in front, as typed
  keys do; nostrings brings the approved app forward first, and switching
  away stops the script, but the helper does not check each key against the
  app in front. System-wide keys (`ui.pressKey`) ask for `macos:system`.
- Stopping cancels input, not every request: an accessibility action (a
  press, a value set) or a read already running in the helper finishes, and
  on a phone the request the device server is running finishes; only what is
  queued behind it is dropped.
- Background input uses two private macOS (SkyLight) functions, the same
  approach as yabai, cua-driver, and Peekaboo. They are looked up at runtime;
  if a macOS update removes them, nostrings falls back to bringing the app
  forward. They do not bypass any permission: the helper still needs
  Accessibility.
- Cells run in a Node `vm` context, which is not a security boundary: a
  script can reach the runner's real `process` (for example through a
  built-in's constructor). The runner process is the boundary, and how strong
  it is depends on the host:
  - Node's permission model is best effort. It is new, bypasses have been
    found and fixed in past releases, and before Node 25 it does not cover the
    network at all. On macOS, Seatbelt covers what it misses. On Linux with
    Node 20 to 24 the runner is not network-isolated: a script that escapes
    `vm` can open network connections and Unix sockets, including adb's port.
    The same holds on a Mac where Seatbelt could not apply and Node is older
    than 25; there the script can also talk to Nostrings Helper's socket
    directly. The helper's own approval gate still holds, but the client name
    and the wording of the dialog are then the script's.
  - On macOS, if `sandbox-exec` cannot apply (for example when nostrings
    itself is started inside another Seatbelt sandbox, as some agent shells
    are), scripts do not run and the error says why. `"isolation":
    "best-effort"` in `~/.nostrings/config.json` lets them run anyway with
    whatever this host allows, and the session's first result and
    `nostrings doctor` then say what is missing. On Linux it is always best
    effort, with the same warning. If Node has no permission model, the
    runner starts without that layer and warns.
  - Seatbelt lets the runner check whether any path exists (file metadata),
    and read the system's libraries and node's own install (for Homebrew's
    node, its `Cellar` and `opt` directories), not your files.
  - A runner a script has taken over can send any request a script could,
    while a call runs. Each one is still checked and gated. The check that
    stops a script when you switch away from an app it brought forward runs
    in the runner, so a taken-over runner can skip it; Escape and timeouts are
    enforced by the host process.
- An approved app is still code execution. The runner limits what a script
  can do outside the apps you approve, not inside them: a script that drives
  an approved Terminal, Script Editor or Shortcuts can run anything they can,
  and an approved app can reach whatever that app can reach. Finder is not on
  the ask-first list, and approving it lets an agent read or change any file
  Finder can.
- nostrings does not screen app or page content for prompt injection. Text an
  agent reads in an approved app can try to steer it.
- `ui.scripts.save` writes a file in `~/.nostrings/scripts/`, the one place a
  session can write (the host process writes it, after checking the name). A saved script never runs by itself, only when a session
  calls `ui.scripts.run` or you run `nostrings script`, and it runs with the
  same approvals as any other script. An agent steered by injected text could
  still save a harmful script for later, so read a script
  (`ui.scripts.source(name)`, or the file) before you rerun one you did not
  write. Saves and runs are logged.
- The optional "nostrings local signing" certificate lives in your login
  keychain and signs only the helper you build. Without it, macOS ties
  privacy grants to an ad-hoc signature and a rebuild means granting again.

## Android devices

- **ADB is the grant.** The nostrings server on a phone runs with shell
  privileges over ADB. Anything else on the Mac that can run `adb` (an agent
  with a terminal, for one) can do the same without nostrings, so approve
  terminal access with that in mind.
- **Approvals are checked on the computer.** The checks below run in the
  nostrings host process, not on the phone. Where the script runner is not
  network-isolated (Linux with Node before 25, or a Mac where the Seatbelt
  sandbox could not apply, with Node before 25), a script that escapes `vm`
  can reach adb (port 5037) and the phone's broker socket directly, and none
  of these checks hold. `nostrings doctor` and the session's first result
  say when the runner is not network-isolated.
- **Ask first, never forbid.** nostrings asks before acting in apps and screens
  that can move money, read messages or one-time codes, or change the phone's
  settings, even under `allow-all`, and it asks again when one of them shows
  inside an app you already approved. It does not block an action you approve.
- **Notifications.** `phone.notifications()` reads the whole shade, which
  can show messages and one-time codes from any app, so it asks first even
  under `allow-all` (approval key `android:notifications`), and each read
  is logged.
- **App functions.** `phone.callAppFunction()` runs a function an app
  publishes for agents (AppFunctions, Android 16 and later) with no screen to
  look at, so it asks like opening that app and each call is logged.
  `phone.appFunctions()`, which lists them and so shows which apps are
  installed, asks first once (approval key `android:appfunctions`).
- **Files.** Scripts cannot read files, but `phone.push(path)` copies a file
  from this computer to the phone, so each file asks first, naming the path
  and size, and each copy is logged.
- **Locked phones.** The server can reach apps behind the lock screen (a
  hidden screen runs even while the phone is locked), so acting on, or
  reading a hidden screen of, a phone locked with a PIN, pattern, password or
  biometric asks once per session. A swipe-only lock screen guards nothing
  and does not ask.
- **Hidden screens.** On Android 14 and later the agent's apps run on private
  displays that never take focus from the phone's screen and show no
  keyboard; input and typing are addressed to that display only and fail
  rather than fall back to the user's screen. nostrings will not open an app
  there that the user is running, since a second copy can close or take over
  theirs. The displays and their apps are destroyed when the session ends or
  the server dies, and never appear in the phone's recent apps. Hidden-screen work
  wakes the phone and keeps it awake until a minute after the last action.
- **No network socket.** The server on the phone talks only over the `adb
  shell` that started it. On the computer, a per-phone broker process owns
  that shell and relays for every nostrings session through a Unix socket in
  `~/.nostrings` that only your user can open; it exits, and the server with
  it, ten seconds after the last session ends.
- **Personal phones.** Developer options and USB debugging are themselves a
  weaker security setting. Use the emulator, or a phone set aside for agents,
  when you can.

## Reporting a vulnerability

Please open a private security advisory at
https://github.com/vpatel9202/nostrings/security/advisories/new rather than a
public issue.

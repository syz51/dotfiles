# computer-use plugin

The `desktop` MCP server gives Claude Code sessions screenshots, mouse and keyboard on this
Mac. SETUP.md's "Computer use" section describes the safeguards. This file covers the
approval policy and the one-time macOS grants.

## Approval policy

The policy decides how `request_access` approves apps:

- `{"approval": "auto"}` (the default): the server approves the apps the model names at
  once. No dialog appears, so no one needs to be at the Mac.
- `{"approval": "dialog"}`: the server shows an Allow/Deny dialog for each request. The
  dialog gives up, and so denies, after 120 seconds.

The server reads the first of these files that exists:

1. `policy.json` in the server's state folder, `~/.local/state/desktop-mcp/policy.json` by
   default (`$DESKTOP_MCP_STATE`, or `$XDG_STATE_HOME/desktop-mcp`, when set). No checkout
   tracks this file, so a branch switch or a commit does not change it. An agent's shell
   can still write it. `DESKTOP_MCP_POLICY` names another file instead.
2. The plugin's own `policy.json`, which sets `auto`.

To switch to the dialog, write `{"approval": "dialog"}` to the first file. Delete it to go
back to the plugin's default. The server reads the policy at each `request_access`, so the
change applies to the next request, also in running sessions. Apps that a session already
has keep their approval until it releases or you press Stop. With no file at all, the server uses
`dialog`. A file that cannot be read, is not valid JSON or has another `approval` value
makes `request_access` fail; the server never guesses a mode.

These safeguards stay in both modes:

- Only the apps the model names are approved. Every action checks the app under the
  pointer or with keyboard focus against that list.
- Banking, healthcare, government and password apps are always refused.
- Apps that reach past Claude Code's permission rules and hooks always need the dialog.
  `DIALOG_APPS` in `server/desktop.js` lists them by name and bundle id:
  - terminals: Terminal, iTerm, Ghostty, Warp, Alacritty, kitty, WezTerm;
  - agent apps: T3 Code, Claude, ChatGPT and Codex;
  - editors with a terminal: Visual Studio Code, Cursor, Windsurf, Zed, Xcode;
  - script tools: Script Editor, Shortcuts, Automator, Raycast, Alfred;
  - system apps: System Settings, Control Center, the system prompt agents
    (CoreServicesUIAgent, UserNotificationCenter, SecurityAgent, SystemUIServer),
    loginwindow, the Dock, Activity Monitor and Installer.
- One session at a time holds the lock.
- The stop panel shows during a session and names the approved apps; hover over it to
  see a long list in full. Its Stop button or Esc ends the session. Force-quitting or
  killing the panel counts as a Stop too.
- After you press Stop, `request_access` shows the dialog in every session, also after a
  server restart, even in `auto` mode. The server records the Stop in `user-stopped` in
  the state folder. Once you allow apps in a dialog, it removes that file and the policy
  applies again. A panel that crashes or fails to start ends the session, but does not
  count as a Stop.
- Each approval adds a JSON line to `approvals.log` in the state folder: the time, the
  apps, the model's reason, and `mode` `auto` or `dialog`.

The `request_access` reply says whether a dialog was shown and why.

## macOS grants (one time)

macOS charges the helper's screen capture and input events to the app that started Claude
Code. On this Mac that is T3 Code. Grant T3 Code both of these once in System Settings >
Privacy & Security:

- Screen Recording
- Accessibility

The grants belong to T3 Code's signed bundle id, not to the helper binary. So a rebuilt
helper keeps them, although each build has a new ad-hoc signature. T3 Code updates keep
them too, because its Developer ID signature stays the same. A session started from
another app, such as a terminal, needs that app granted once as well.

To check the grants, run the newest built helper with `permissions` from a T3 Code
terminal. Both values should be `true`:

```sh
state="${DESKTOP_MCP_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/desktop-mcp}"
"$(ls -t "$state"/desktop-helper-* | grep -v '\.tmp$' | head -1)" permissions
```

The `grep` skips a build still in progress, which ends in `.tmp`.

## Locked screen

The server cannot act while the screen is locked: loginwindow is then frontmost and no
approved app is under the pointer. The server does not unlock the Mac and does not change
lock, screensaver or power settings.

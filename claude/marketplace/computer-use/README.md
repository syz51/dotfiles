# computer-use plugin

The `desktop` MCP server gives Claude Code sessions screenshots, mouse and keyboard on this
Mac. SETUP.md's "Computer use" section describes the safeguards. This file covers the
approval policy and the one-time macOS grants.

## Approval policy

`policy.json` decides how `request_access` approves apps:

- `{"approval": "auto"}` (the default): the server approves the apps the model names at
  once. No dialog appears, so no one needs to be at the Mac.
- `{"approval": "dialog"}`: the server shows an Allow/Deny dialog for each request. The
  dialog gives up, and so denies, after 120 seconds.

`.mcp.json` sets `DESKTOP_MCP_POLICY` to the copy in the dotfiles checkout,
`~/.config/claude/marketplace/computer-use/policy.json`. Edit that file to switch modes.
The server reads it at each `request_access`, so the change takes effect at once, also in
running sessions. When that file is missing, the plugin's own `policy.json` applies. With
no file at all, the server uses `dialog`. A file that is not valid JSON or has another
`approval` value makes `request_access` fail; the server never guesses a mode.

These safeguards stay in both modes:

- Only the apps the model names are approved. Every action checks the app under the
  pointer or with keyboard focus against that list.
- Banking, healthcare, government and password apps are always refused.
- One session at a time holds the lock.
- The stop panel shows during a session. Its Stop button or Esc ends the session.
- After you press Stop, the next `request_access` in that session shows the dialog, even
  in `auto` mode. Once you allow apps in that dialog, the policy applies again.

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
"$(ls -t ~/.local/state/desktop-mcp/desktop-helper-* | head -1)" permissions
```

## Locked screen

The server cannot act while the screen is locked: loginwindow is then frontmost and no
approved app is under the pointer. The server does not unlock the Mac and does not change
lock, screensaver or power settings.

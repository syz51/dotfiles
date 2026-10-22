# T3 Code desktop host

This Mac (`SUN的MacBook Air`) hosts the existing T3 Code Nightly environment.
T3 Connect is enabled in **Settings → Connections**. Codex and Claude run here;
the other Mac connects to this environment to use its files, terminals, and threads.
Credentials and T3 state stay outside this repository in `~/.t3`.

## Startup

`com.syz51.t3code.desktop.plist` opens `/Applications/T3 Code (Nightly).app`
in the background at graphical login. It is linked into `~/Library/LaunchAgents`.
It runs once at login; it does not restart an app you quit or replace T3's server
with a separate service. Keep the desktop app running while using it remotely.

The plist is local to this Mac and excluded from Git. On another host, create
the plist locally with that host's app path before installing the symlink:

```sh
ln -s "$HOME/.config/t3/com.syz51.t3code.desktop.plist" \
  "$HOME/Library/LaunchAgents/com.syz51.t3code.desktop.plist"
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.syz51.t3code.desktop.plist"
```

To check startup:

```sh
launchctl print "gui/$(id -u)/com.syz51.t3code.desktop"
```

An idle launcher with `last exit code = 0` is expected: `open` exits after opening
the app. A real reboot/login has not been tested as part of setup.

To disable automatic startup without deleting T3 data:

```sh
launchctl bootout "gui/$(id -u)/com.syz51.t3code.desktop"
unlink "$HOME/Library/LaunchAgents/com.syz51.t3code.desktop.plist"
```

The desktop app's bundled CLI is available through
`~/.local/bin/t3 → ~/.t3/bin/t3`. Use `t3 --version` to check it. Update the
desktop app normally to update this CLI too. Do not install a second server on
the same T3 data directory while the desktop host is running.

## Connect from the second Mac

1. Open T3 Code on the other Mac, preferably the same Nightly version.
2. Sign in to the same T3 Connect account.
3. In **Settings → Connections**, choose/add `SUN的MacBook Air` from T3 Connect.
4. Open an existing Air thread or select the Air environment for a new thread.
   Files and commands then run on the Air, even while its display is locked.

Alternatively, open <https://app.t3.codes> and sign in to the same account.
Direct LAN network access is off; T3 Connect supplies the remote route.

## Availability and checks

- Keep the Air plugged in, awake, and logged in. Locking the screen is fine;
  logging out or quitting T3 disconnects the host.
- AC idle sleep was already disabled (`pmset -g custom`: AC `sleep 0`);
  the display may sleep after ten minutes. Battery sleep settings were preserved.
- Closing a MacBook lid may still put it to sleep. This setup does not override
  lid sleep; leave the lid open or use a supported powered clamshell setup.
- After reboot, unlock FileVault if prompted and log in so the app can start.
- Check **Settings → Connections** on the Air: Local environment and T3 Connect
  should be on, with a reachable status. CLI `t3 connect status` reports the CLI's
  separate sign-in/exposure preferences and can show disabled/missing even when
  the desktop-managed tunnel is active; use the desktop host status for this setup.

Setup verification on 2026-10-21: launchd startup action exited successfully,
existing desktop/server processes stayed running, and the host's authenticated
T3 reachability check returned `reachable`, four connections, protocol `quic`.
The temporary diagnostic session was revoked. A connection from the second Mac,
a reboot, and lid-closed operation have not been tested.

Official reference: [remote access](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md).

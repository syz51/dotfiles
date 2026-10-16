import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

# Use the config-path wrapper, which forwards to Homebrew.
TUIOS = "/Users/roy/.local/bin/tuios"


def read_list(command):
    result = subprocess.run(
        [TUIOS, command, "--json"], capture_output=True, text=True,
        check=True, timeout=2,
    )
    rows = json.loads(result.stdout)
    if not isinstance(rows, list):
        raise ValueError(f"{command} did not return a list")
    return rows


def launch():
    # Keep this file in place so every launcher locks the same inode.
    lock = os.open(Path(__file__).with_suffix(".lock"), os.O_CREAT | os.O_RDWR, 0o600)
    client = None
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            sessions = read_list("ls")
        except subprocess.CalledProcessError as error:
            if error.returncode != 3:
                raise
            command = ["attach"]  # Restore saved sessions when the daemon is stopped.
        else:
            detached = [session for session in sessions if session["attached"] is False]
            if detached:
                session = max(detached, key=lambda s: s["last_active"])
                command = ["attach", session["name"]]
            else:
                command = ["new"]

        client = subprocess.Popen([TUIOS, *command])
        deadline = time.monotonic() + 15
        while client.poll() is None:
            try:
                clients = read_list("list-clients")
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                clients = []  # The client may still be starting the daemon.
            if any(row["pid"] == client.pid and row["session"] for row in clients):
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("TUIOS did not confirm attachment within 15 seconds")
            time.sleep(0.05)
        fcntl.flock(lock, fcntl.LOCK_UN)
        return client.wait()
    finally:
        if client is not None and client.poll() is None:
            client.terminate()
            try:
                client.wait(timeout=5)
            except subprocess.TimeoutExpired:
                client.kill()
                client.wait()
        os.close(lock)


def stop(signum, _frame):
    raise SystemExit(128 + signum)


if __name__ == "__main__":
    for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, stop)
    try:
        sys.exit(launch())
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, RuntimeError) as error:
        print(f"tuios-launcher: {error}", file=sys.stderr)
        sys.exit(1)

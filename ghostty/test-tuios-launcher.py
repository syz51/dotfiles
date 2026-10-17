import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

FAKE_TUIOS = r'''#!/usr/bin/env python3
import contextlib, fcntl, json, os, pathlib, signal, sys, time
root = pathlib.Path(__file__).parent

@contextlib.contextmanager
def state():
    with (root / "state.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = json.loads((root / "state.json").read_text())
        yield data
        (root / "state.json").write_text(json.dumps(data))

def stop(signum, frame):
    raise SystemExit(128 + signum)
signal.signal(signal.SIGTERM, stop)
command = sys.argv[1]
if command == "ls":
    with state() as data:
        output = data.get("ls_output", json.dumps(data["sessions"]))
        status = data.get("ls_status", 0)
    print(output)
    sys.exit(status)
if command == "list-clients":
    with state() as data:
        print(json.dumps(data["clients"]))
    sys.exit(0)
with state() as data:
    if command == "attach" and len(sys.argv) > 2:
        name = sys.argv[2]
    elif command == "attach" and data["sessions"]:
        name = max(data["sessions"], key=lambda s: s["last_active"])["name"]
    else:
        name = "new-" + str(os.getpid())
    if not any(s["name"] == name for s in data["sessions"]):
        data["sessions"].append({"name": name, "attached": False, "last_active": 0})
    data["calls"].append({"command": command, "session": name, "pid": os.getpid()})
    data["ls_status"] = 0
    delay = data.get("attach_delay", 0.25)
    exit_code = data.get("client_exit")
if exit_code is not None:
    sys.exit(exit_code)
time.sleep(delay)
with state() as data:
    next(s for s in data["sessions"] if s["name"] == name)["attached"] = True
    data["clients"].append({"pid": os.getpid(), "session": name})
try:
    while True:
        time.sleep(0.05)
finally:
    with state() as data:
        data["clients"] = [c for c in data["clients"] if c["pid"] != os.getpid()]
        next(s for s in data["sessions"] if s["name"] == name)["attached"] = any(c["session"] == name for c in data["clients"])
'''


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        fake = self.root / "tuios"
        fake.write_text(FAKE_TUIOS)
        fake.chmod(0o700)
        source = Path(__file__).with_name("tuios-launcher.py").read_text()
        (self.root / "launcher.py").write_text(source.replace(
            'str(Path.home() / ".local/bin/tuios")', repr(str(fake))
        ).replace("time.monotonic() + 15", "time.monotonic() + 1.5"))
        shell = Path(__file__).with_name("tuios-launcher.sh").read_text()
        (self.root / "launcher.sh").write_text(shell.replace(
            "$HOME/.config/ghostty/tuios-launcher.py", str(self.root / "launcher.py")
        ))
        self.processes = []
        self.addCleanup(self.stop_processes)
        self.write_state([])

    def write_state(self, sessions, **extra):
        (self.root / "state.json").write_text(json.dumps({
            "sessions": sessions, "clients": [], "calls": [], **extra,
        }))

    def read_state(self):
        with (self.root / "state.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return json.loads((self.root / "state.json").read_text())

    def start(self):
        process = subprocess.Popen(
            ["/bin/sh", str(self.root / "launcher.sh")],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE, text=True,
        )
        self.processes.append(process)
        return process

    def until(self, predicate):
        deadline = time.monotonic() + 5
        while not predicate(self.read_state()):
            self.assertLess(time.monotonic(), deadline, "Launcher did not progress")
            time.sleep(0.01)

    def stop_processes(self):
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
            process.communicate(timeout=7)

    def concurrent_launches(self):
        self.start()
        self.until(lambda data: len(data["calls"]) == 1)
        # Start the second window while the first client's attach is still pending.
        self.assertEqual(self.read_state()["clients"], [])
        self.start()
        self.until(lambda data: len(data["clients"]) == 2)
        calls = self.read_state()["calls"]
        self.assertEqual(len(calls), 2)
        self.assertNotEqual(calls[0]["session"], calls[1]["session"])
        return calls

    def test_concurrent_reuse_then_new(self):
        self.write_state([{"name": "detached", "attached": False, "last_active": 1}])
        calls = self.concurrent_launches()
        self.assertEqual([call["command"] for call in calls], ["attach", "new"])

    def test_concurrent_new_sessions(self):
        calls = self.concurrent_launches()
        self.assertEqual([call["command"] for call in calls], ["new", "new"])

    def test_concurrent_restoration(self):
        self.write_state([{"name": "saved", "attached": False, "last_active": 1}], ls_status=3)
        calls = self.concurrent_launches()
        self.assertEqual([call["command"] for call in calls], ["attach", "new"])

    def test_concurrent_two_detached(self):
        self.write_state([
            {"name": "older", "attached": False, "last_active": 1},
            {"name": "newer", "attached": False, "last_active": 2},
        ])
        self.assertEqual([call["session"] for call in self.concurrent_launches()], ["newer", "older"])

    def test_selects_latest_detached(self):
        self.write_state([
            {"name": "older", "attached": False, "last_active": 1},
            {"name": "latest detached", "attached": False, "last_active": 2},
            {"name": "busy", "attached": True, "last_active": 3},
        ])
        self.start()
        self.until(lambda data: len(data["clients"]) == 1)
        self.assertEqual(self.read_state()["calls"][0]["session"], "latest detached")

    def test_all_attached_creates_new(self):
        self.write_state([{"name": "busy", "attached": True, "last_active": 1}])
        self.start()
        self.until(lambda data: len(data["clients"]) == 1)
        self.assertEqual(self.read_state()["calls"][0]["command"], "new")

    def test_invalid_or_failed_listing_does_not_launch(self):
        for extra in ({"ls_status": 1}, {"ls_output": "invalid JSON"}, {"ls_output": "{}"}):
            with self.subTest(extra=extra):
                self.write_state([], **extra)
                process = self.start()
                self.assertNotEqual(process.wait(timeout=5), 0)
                self.assertEqual(self.read_state()["calls"], [])

    def test_failed_client_releases_lock(self):
        self.write_state([], client_exit=7)
        first, second = self.start(), self.start()
        self.assertEqual(first.wait(timeout=5), 7)
        self.assertEqual(second.wait(timeout=5), 7)

    def test_timeout_stops_client_and_releases_lock(self):
        source = self.root / "launcher.py"
        source.write_text(source.read_text().replace("time.monotonic() + 1.5", "time.monotonic() + 0.3"))
        self.write_state([], attach_delay=10)
        first, second = self.start(), self.start()
        self.assertEqual(first.wait(timeout=5), 1)
        self.assertEqual(second.wait(timeout=5), 1)
        for call in self.read_state()["calls"]:
            with self.assertRaises(ProcessLookupError):
                os.kill(call["pid"], 0)


if __name__ == "__main__":
    unittest.main()

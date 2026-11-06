#!/usr/bin/env python3
"""Alert through T3 Code and macOS notifications when free disk space runs low.

A LaunchAgent runs `check` every 10 minutes. It reads the free space on the Data
volume and sorts it into a level: `ok`, `low` (below 30 GB) or `critical` (below
20 GB), where GB means 10^9 bytes. Falling into a worse level alerts at once, and
staying low alerts again every 24 hours. A level only eases once free space is
2 GB above its threshold, so readings that hover near a threshold do not flap.

Each alert posts a macOS notification and messages T3 Code. The first alert of an
episode starts a thread in the T3 project at `~/.t3/scratch` ("No project") that
asks for a read-only look at where the space went; later alerts in the same
episode go to that thread. When `t3` fails outright, every later check retries
until the message gets through, without repeating the notification; a start that
timed out or printed no thread id is not retried, since it may have gone through.
Recovering to `ok` posts one notification and ends the episode.

State lives in `~/.local/state/disk-space-alert/state.json` and every alert adds
one line to `events.jsonl` there. `test` sends a test alert through both channels
without touching the state, `status` reports the current reading, and `install`
writes and loads the LaunchAgent.
"""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Optional

HOME = Path.home()
LABEL = "com.syz51.disk-space-alert"
DEFAULT_VOLUME = "/System/Volumes/Data"
DEFAULT_LOW_GB = 30.0
DEFAULT_CRITICAL_GB = 20.0
HYSTERESIS_GB = 2.0
REMIND_AFTER = timedelta(hours=24)
INTERVAL_SECONDS = 600
DEFAULT_STATE_DIR = HOME / ".local" / "state" / "disk-space-alert"
DEFAULT_T3 = HOME / ".t3" / "bin" / "t3"
DEFAULT_T3_PROJECT = HOME / ".t3" / "scratch"
DEFAULT_OSASCRIPT = "/usr/bin/osascript"
LAUNCH_AGENTS = HOME / "Library" / "LaunchAgents"
COMMAND_TIMEOUT_SECONDS = 90
TIMEOUT_EXIT = 124

LEVELS = ("ok", "low", "critical")

Runner = Callable[[list, Optional[str]], subprocess.CompletedProcess]


def run_command(args: list, input_text: Optional[str] = None) -> subprocess.CompletedProcess:
    """Run a command, turning a missing program or a timeout into a failed result."""
    try:
        return subprocess.run(
            args,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as error:
        return subprocess.CompletedProcess(args, 127, "", str(error))
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(
            args, TIMEOUT_EXIT, "", f"timed out after {COMMAND_TIMEOUT_SECONDS} seconds"
        )


@dataclass(frozen=True)
class Config:
    volume: str = DEFAULT_VOLUME
    low_gb: float = DEFAULT_LOW_GB
    critical_gb: float = DEFAULT_CRITICAL_GB
    state_dir: Path = DEFAULT_STATE_DIR
    t3: Optional[str] = str(DEFAULT_T3)
    t3_project: str = str(DEFAULT_T3_PROJECT)
    osascript: Optional[str] = DEFAULT_OSASCRIPT


@dataclass(frozen=True)
class State:
    level: str = "ok"
    thread_id: Optional[str] = None
    last_alert_at: Optional[str] = None
    pending: bool = False


def free_gb(volume: str) -> float:
    stats = os.statvfs(volume)
    return stats.f_bavail * stats.f_frsize / 1e9


def classify(free: float, previous: str, low_gb: float, critical_gb: float) -> str:
    """Return the level for a reading, easing a level only past its threshold plus the margin."""
    if free < critical_gb:
        level = "critical"
    elif free < low_gb:
        level = "low"
    else:
        level = "ok"
    if previous == "critical" and level != "critical" and free < critical_gb + HYSTERESIS_GB:
        level = "critical"
    if previous in ("low", "critical") and level == "ok" and free < low_gb + HYSTERESIS_GB:
        level = "low"
    return level


def plan(state: State, level: str, now: datetime) -> Optional[str]:
    """Return the event a check should act on: escalated, reminder, retry, recovered or None."""
    if level == "ok":
        return "recovered" if state.level != "ok" else None
    if LEVELS.index(level) > LEVELS.index(state.level):
        return "escalated"
    if state.last_alert_at is None or now - parse_time(state.last_alert_at) >= REMIND_AFTER:
        return "reminder"
    if state.pending:
        return "retry"
    return None


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value)


def load_state(path: Path) -> State:
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError:
        return State()
    except (OSError, ValueError) as error:
        print(f"Ignoring unreadable state {path}: {error}", file=sys.stderr)
        return State()
    try:
        state = State(
            level=data.get("level", "ok"),
            thread_id=data.get("thread_id"),
            last_alert_at=data.get("last_alert_at"),
            pending=bool(data.get("pending", False)),
        )
        if state.level not in LEVELS:
            raise ValueError(f"unknown level {state.level!r}")
        if state.last_alert_at is not None:
            parse_time(state.last_alert_at)
    except (AttributeError, TypeError, ValueError) as error:
        print(f"Ignoring invalid state {path}: {error}", file=sys.stderr)
        return State()
    return state


def save_state(path: Path, state: State) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(asdict(state), indent=2) + "\n")
    temporary.replace(path)


def append_event(state_dir: Path, event: dict) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    with open(state_dir / "events.jsonl", "a") as log:
        log.write(json.dumps(event, ensure_ascii=False) + "\n")


def describe(level: str, config: Config) -> str:
    if level == "critical":
        return f"below the {config.critical_gb:g} GB critical threshold"
    return f"below the {config.low_gb:g} GB low-space threshold"


def thread_title(level: str, free: float) -> str:
    prefix = "Critical disk space" if level == "critical" else "Low disk space"
    return f"{prefix}: {free:.1f} GB free"


def start_message(level: str, free: float, config: Config) -> str:
    return (
        "This thread was started by the disk space monitor "
        f"(`~/.config/disk-alert/disk_space_alert.py`, LaunchAgent `{LABEL}`).\n\n"
        f"Free space on {config.volume} is {free:.1f} GB, {describe(level, config)}. "
        f"The monitor alerts below {config.low_gb:g} GB and again below "
        f"{config.critical_gb:g} GB.\n\n"
        "Make a read-only check of where the space is going: the largest folders in the "
        "home directory, Docker and Colima disks, caches, build output such as Rust "
        "`target/` folders, and anything that grew recently. Reply with a short summary "
        "and a list of cleanup candidates with their sizes and how safe each is to remove.\n\n"
        "Do not delete, move or change anything, and do not start subagents. Wait for me "
        "to choose what to clean."
    )


def update_message(level: str, free: float, config: Config) -> str:
    return (
        f"Update from the disk space monitor: free space on {config.volume} is now "
        f"{free:.1f} GB, {describe(level, config)}. Refresh your read-only summary in a "
        "few lines. Still do not delete, move or change anything."
    )


TEST_MESSAGE = (
    "This is a test of the disk space monitor "
    f"(`~/.config/disk-alert/disk_space_alert.py`, LaunchAgent `{LABEL}`). "
    "Reply with one line confirming you received it, and do nothing else."
)


def notify(run: Runner, config: Config, title: str, message: str) -> Optional[str]:
    """Post a macOS notification; return an error description when it fails."""
    if not config.osascript:
        return None
    result = run(
        [
            config.osascript,
            "-e",
            "on run argv",
            "-e",
            'display notification (item 2 of argv) with title (item 1 of argv) sound name "Basso"',
            "-e",
            "end run",
            title,
            message,
        ],
        None,
    )
    if result.returncode != 0:
        return f"osascript exit {result.returncode}: {result.stderr.strip()}"
    return None


@dataclass(frozen=True)
class Delivery:
    thread_id: Optional[str] = None
    error: Optional[str] = None
    retry: bool = False


def started_thread_id(stdout: str) -> Optional[str]:
    """Return the threadId from the last JSON object line `t3 thread start --json` printed."""
    for line in reversed(stdout.splitlines()):
        try:
            data = json.loads(line)
        except ValueError:
            continue
        if isinstance(data, dict) and isinstance(data.get("threadId"), str):
            return data["threadId"]
    return None


def deliver(
    run: Runner, config: Config, thread_id: Optional[str], title: str, first: str, update: str
) -> Delivery:
    """Message the episode's T3 thread, starting one when needed.

    Only a start that failed outright is retried. A start that timed out or printed
    no thread id may still have created a thread, so retrying it every check could
    flood T3 with duplicates.
    """
    if not config.t3:
        return Delivery(thread_id=thread_id)
    errors = []
    if thread_id:
        sent = run([config.t3, "thread", "send", "--json", thread_id, "-"], update)
        if sent.returncode == 0:
            return Delivery(thread_id=thread_id)
        errors.append(f"send exit {sent.returncode}: {(sent.stderr or sent.stdout).strip()}")
    started = run(
        [config.t3, "thread", "start", "--json", "--title", title, config.t3_project, "-"],
        first,
    )
    output = (started.stderr or started.stdout).strip()
    if started.returncode == 0:
        new_id = started_thread_id(started.stdout)
        if new_id:
            return Delivery(thread_id=new_id)
        errors.append(f"start printed no thread id, not retrying: {started.stdout.strip()[:200]}")
        return Delivery(error="; ".join(errors))
    if started.returncode == TIMEOUT_EXIT:
        errors.append(f"start {output}, not retrying in case it went through")
        return Delivery(error="; ".join(errors))
    errors.append(f"start exit {started.returncode}: {output}")
    return Delivery(error="; ".join(errors), retry=True)


def check(
    free: float, state: State, now: datetime, config: Config, run: Runner
) -> tuple:
    """Act on one reading. Returns (new state, event record or None)."""
    level = classify(free, state.level, config.low_gb, config.critical_gb)
    event = plan(state, level, now)
    record = {
        "at": now.isoformat(timespec="seconds"),
        "event": event,
        "level": level,
        "free_gb": round(free, 2),
    }
    if event is None:
        return replace(state, level=level), None
    if event == "recovered":
        record["notify_error"] = notify(
            run,
            config,
            "Disk space recovered",
            f"{free:.1f} GB free on {config.volume}; the low-space alert has cleared.",
        )
        return State(), record

    title = thread_title(level, free)
    delivery = deliver(
        run,
        config,
        state.thread_id,
        title,
        start_message(level, free, config),
        update_message(level, free, config),
    )
    record["thread_id"] = delivery.thread_id
    record["t3_error"] = delivery.error
    new_state = State(
        level=level,
        thread_id=state.thread_id if delivery.retry else delivery.thread_id,
        last_alert_at=state.last_alert_at,
        pending=delivery.retry,
    )
    if event != "retry":
        body = f"{free:.1f} GB free on {config.volume}, {describe(level, config)}."
        if delivery.retry:
            body += " T3 Code could not be reached; retrying."
        elif delivery.error:
            body += " T3 Code may not have received it; see events.jsonl."
        elif config.t3:
            body += " Details in T3 Code."
        record["notify_error"] = notify(run, config, title, body)
        new_state = replace(new_state, last_alert_at=now.isoformat(timespec="seconds"))
    return new_state, record


def run_check(config: Config, run: Runner, free_override: Optional[float], now: datetime) -> int:
    free = free_override if free_override is not None else free_gb(config.volume)
    state_path = config.state_dir / "state.json"
    state, record = check(free, load_state(state_path), now, config, run)
    save_state(state_path, state)
    if record is None:
        return 0
    append_event(config.state_dir, record)
    print(json.dumps(record, ensure_ascii=False))
    return 1 if record.get("t3_error") or record.get("notify_error") else 0


def run_test(config: Config, run: Runner, now: datetime) -> int:
    free = free_gb(config.volume)
    delivery = deliver(run, config, None, "Disk space alert test", TEST_MESSAGE, TEST_MESSAGE)
    body = f"Test alert: {free:.1f} GB free on {config.volume}."
    if delivery.error:
        body += " T3 Code did not confirm a thread."
    elif config.t3:
        body += " A T3 Code thread was started."
    notify_error = notify(run, config, "Disk space alert test", body)
    record = {
        "at": now.isoformat(timespec="seconds"),
        "event": "test",
        "free_gb": round(free, 2),
        "thread_id": delivery.thread_id,
        "t3_error": delivery.error,
        "notify_error": notify_error,
    }
    append_event(config.state_dir, record)
    print(json.dumps(record, ensure_ascii=False))
    return 1 if delivery.error or notify_error else 0


def plist_path() -> Path:
    return LAUNCH_AGENTS / f"{LABEL}.plist"


def launch_agent(
    uv: str, script: Path, state_dir: Path, low_gb: float, critical_gb: float
) -> dict:
    return {
        "Label": LABEL,
        "ProgramArguments": [
            uv,
            "run",
            "--no-project",
            "--python",
            "3.11",
            "python",
            "-B",
            str(script),
            "check",
            "--low-gb",
            f"{low_gb:g}",
            "--critical-gb",
            f"{critical_gb:g}",
        ],
        "StartInterval": INTERVAL_SECONDS,
        "RunAtLoad": True,
        "ProcessType": "Background",
        "EnvironmentVariables": {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"},
        "StandardOutPath": str(state_dir / "launchd.log"),
        "StandardErrorPath": str(state_dir / "launchd.log"),
    }


def run_install(run: Runner, dry_run: bool, low_gb: float, critical_gb: float) -> int:
    uv = shutil.which("uv")
    if uv is None:
        print("uv is not on PATH; install it first.", file=sys.stderr)
        return 1
    agent = launch_agent(
        str(Path(uv).resolve()), Path(__file__).resolve(), DEFAULT_STATE_DIR, low_gb, critical_gb
    )
    if dry_run:
        sys.stdout.write(plistlib.dumps(agent).decode())
        return 0
    DEFAULT_STATE_DIR.mkdir(parents=True, exist_ok=True)
    LAUNCH_AGENTS.mkdir(parents=True, exist_ok=True)
    plist_path().write_bytes(plistlib.dumps(agent))
    domain = f"gui/{os.getuid()}"
    run(["launchctl", "bootout", f"{domain}/{LABEL}"], None)
    loaded = run(["launchctl", "bootstrap", domain, str(plist_path())], None)
    if loaded.returncode != 0:
        print(f"launchctl bootstrap failed: {loaded.stderr.strip()}", file=sys.stderr)
        return 1
    print(f"Loaded {LABEL} from {plist_path()}")
    return 0


def run_uninstall(run: Runner) -> int:
    run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"], None)
    plist_path().unlink(missing_ok=True)
    print(f"Removed {LABEL}; state in {DEFAULT_STATE_DIR} is kept.")
    return 0


def run_status(config: Config, run: Runner) -> int:
    free = free_gb(config.volume)
    state = load_state(config.state_dir / "state.json")
    loaded = run(["launchctl", "print", f"gui/{os.getuid()}/{LABEL}"], None).returncode == 0
    print(
        json.dumps(
            {
                "volume": config.volume,
                "free_gb": round(free, 2),
                "level_now": classify(free, state.level, config.low_gb, config.critical_gb),
                "thresholds_gb": {"low": config.low_gb, "critical": config.critical_gb},
                "state": asdict(state),
                "launch_agent_loaded": loaded,
            },
            indent=2,
        )
    )
    return 0


def parse_args(argv: list) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)

    def add_common(command: argparse.ArgumentParser) -> None:
        command.add_argument("--volume", default=DEFAULT_VOLUME)
        command.add_argument("--low-gb", type=float, default=DEFAULT_LOW_GB)
        command.add_argument("--critical-gb", type=float, default=DEFAULT_CRITICAL_GB)
        command.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
        command.add_argument("--t3", default=str(DEFAULT_T3), help="t3 CLI path")
        command.add_argument("--t3-project", default=str(DEFAULT_T3_PROJECT))
        command.add_argument("--no-t3", action="store_true", help="skip T3 Code")
        command.add_argument("--osascript", default=DEFAULT_OSASCRIPT)
        command.add_argument("--no-notify", action="store_true", help="skip macOS notifications")

    check_command = commands.add_parser("check", help="measure once and alert if needed")
    add_common(check_command)
    check_command.add_argument(
        "--free-gb", type=float, help="use this reading instead of measuring (for testing)"
    )
    add_common(commands.add_parser("test", help="send a test alert through both channels"))
    add_common(commands.add_parser("status", help="show the reading, state and agent"))
    install = commands.add_parser("install", help="write and load the LaunchAgent")
    install.add_argument("--dry-run", action="store_true", help="print the plist only")
    install.add_argument("--low-gb", type=float, default=DEFAULT_LOW_GB)
    install.add_argument("--critical-gb", type=float, default=DEFAULT_CRITICAL_GB)
    commands.add_parser("uninstall", help="unload and remove the LaunchAgent")

    args = parser.parse_args(argv)
    if args.command != "uninstall" and args.critical_gb >= args.low_gb:
        parser.error("--critical-gb must be below --low-gb")
    return args


def main(argv: Optional[list] = None, run: Runner = run_command) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    now = datetime.now(timezone.utc)
    if args.command == "install":
        return run_install(run, args.dry_run, args.low_gb, args.critical_gb)
    if args.command == "uninstall":
        return run_uninstall(run)
    config = Config(
        volume=args.volume,
        low_gb=args.low_gb,
        critical_gb=args.critical_gb,
        state_dir=args.state_dir,
        t3=None if args.no_t3 else args.t3,
        t3_project=args.t3_project,
        osascript=None if args.no_notify else args.osascript,
    )
    if args.command == "check":
        return run_check(config, run, args.free_gb, now)
    if args.command == "test":
        return run_test(config, run, now)
    return run_status(config, run)


if __name__ == "__main__":
    sys.exit(main())

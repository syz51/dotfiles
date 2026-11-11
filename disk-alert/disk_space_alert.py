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

While space is low, each check, after it has alerted, removes the scratch folders of idle Claude Code
sessions, `/private/tmp/claude-<uid>/<project>/<session id>`: those whose folder,
transcript and subagent transcripts have not changed for 24 hours, that Claude Code's
registry of running sessions (`~/.claude/sessions`) does not list, and that no
running process names or works inside. When any of that cannot be read, the folder
stays.

The same checks then empty idle Rust build folders in agent worktrees: the cargo
`target/` folders in T3 worktrees (`~/.t3/worktrees/<project>/<name>`) and in the
Claude Code worktrees (`<repo>/.claude/worktrees/<name>`) of the repositories those
belong to. A folder qualifies when cargo's `CACHEDIR.TAG` marks it, every cargo build
lock in it can be taken at once, nothing in it has changed for 6 hours (1 hour while
space is critical), and no running process names it or works inside it. The locks
are taken first and held to the end. Emptying keeps the tag and the lock files, so a
build that starts meanwhile waits on the same locks and then starts afresh in a
folder still tagged.

Sweeping moves each folder to remove into `trash/` in the state folder with one
rename, so it leaves its place at once, and then deletes it there. A sweep stops after
`--sweep-minutes` (5 by default), so the run ends and launchd can start the next
check; the next sweep first finishes what the trash still holds. A notification says
what a sweep removed. `sweep --dry-run` lists what would go now, whatever the free
space; a simulated reading (`check --free-gb`) never sweeps.

State lives in `~/.local/state/disk-space-alert/state.json` and every alert adds
one line to `events.jsonl` there. `test` sends a test alert through both channels
without touching the state, `status` reports the current reading, and `install`
writes and loads the LaunchAgent.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, field, replace
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
# A sweep stops after this long, so the run ends and launchd can start the next check.
DEFAULT_SWEEP_MINUTES = 5.0
DEFAULT_STATE_DIR = HOME / ".local" / "state" / "disk-space-alert"
DEFAULT_T3 = HOME / ".t3" / "bin" / "t3"
DEFAULT_T3_PROJECT = HOME / ".t3" / "scratch"
DEFAULT_OSASCRIPT = "/usr/bin/osascript"
LAUNCH_AGENTS = HOME / "Library" / "LaunchAgents"
COMMAND_TIMEOUT_SECONDS = 90
TIMEOUT_EXIT = 124

LEVELS = ("ok", "low", "critical")
DEFAULT_CLAUDE_TMP = Path("/private/tmp") / f"claude-{os.getuid()}"
DEFAULT_CLAUDE_PROJECTS = HOME / ".claude" / "projects"
DEFAULT_CLAUDE_SESSIONS = HOME / ".claude" / "sessions"
PROCESS_SNAPSHOT_SECONDS = 5
SWEEP_IDLE = timedelta(hours=24)
SESSION_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DEFAULT_WORKTREES = HOME / ".t3" / "worktrees"
TARGET_IDLE = {"low": timedelta(hours=6), "critical": timedelta(hours=1)}
# The first line of the CACHEDIR.TAG cargo writes into every target folder.
CARGO_TAG = b"Signature: 8a477f597d28d172789f06886806bc55"
# Cargo holds these in each profile folder (target/debug, target/<triple>/release, ...)
# for the whole of a build.
CARGO_LOCKS = frozenset((".cargo-lock", ".cargo-build-lock", ".cargo-artifact-lock"))
TARGET_SEARCH_DEPTH = 6
LOCK_SEARCH_DEPTH = 3

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
    # Claude Code's temp folder to sweep while space is low; None turns the sweep off. The
    # other two are read when the config is made, so tests can point them elsewhere.
    claude_tmp: Optional[Path] = None
    claude_projects: Path = field(default_factory=lambda: DEFAULT_CLAUDE_PROJECTS)
    claude_sessions: Path = field(default_factory=lambda: DEFAULT_CLAUDE_SESSIONS)
    # T3's worktree folder, whose cargo target folders are swept while space is low;
    # None turns that sweep off.
    worktrees: Optional[Path] = None
    sweep_minutes: float = DEFAULT_SWEEP_MINUTES


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


@dataclass(frozen=True)
class Swept:
    path: str
    bytes: int
    error: Optional[str] = None
    kind: str = "session"


@dataclass(frozen=True)
class Processes:
    """What is running: session ids from Claude Code's registry, every command line
    (joined) and every working directory."""

    session_ids: frozenset
    commands: str
    cwds: tuple

    def works_inside(self, folder: Path) -> bool:
        real = str(folder.resolve())
        return any(cwd == real or cwd.startswith(real + "/") for cwd in self.cwds)

    def use(self, session: Path) -> bool:
        return session.name in self.session_ids or session.name in self.commands or self.works_inside(session)

    def inside(self, folder: Path) -> bool:
        """Whether a running command names folder or anything in it, or works inside it."""
        return str(folder.resolve()) in self.commands or self.works_inside(folder)


def registered_sessions(registry: Path) -> Optional[frozenset]:
    """Session ids of running Claude Code processes, from the `<pid>.json` files Claude
    Code keeps in registry. A pid that exists counts even if it was reused, since that
    only keeps a folder; a running process whose entry cannot be read gives None."""
    ids = set()
    for entry in sorted(registry.glob("*.json")):
        try:
            pid = int(entry.stem)
        except ValueError:
            continue
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            continue
        except PermissionError:
            pass
        try:
            session_id = json.loads(entry.read_text()).get("sessionId")
        except (OSError, ValueError, AttributeError):
            return None
        if isinstance(session_id, str):
            ids.add(session_id)
    return frozenset(ids)


def running_processes(run: Runner, registry: Optional[Path]) -> Optional[Processes]:
    """A snapshot of what is running, or None when any part of it cannot be read. With
    no registry, the snapshot has no session ids and does not read one."""
    session_ids = frozenset() if registry is None else registered_sessions(registry)
    ps = run(["ps", "-axww", "-o", "command="], None)
    # lsof exits 1 when it could not inspect some processes; what it printed still counts.
    lsof = run(["lsof", "-nP", "-d", "cwd", "-Fn"], None)
    if session_ids is None or ps.returncode != 0 or not ps.stdout or not lsof.stdout:
        return None
    cwds = tuple(line[1:] for line in lsof.stdout.splitlines() if line.startswith("n/"))
    return Processes(session_ids, ps.stdout, cwds)


def idle_size(path: Path, cutoff: float) -> Optional[int]:
    """The disk space path and everything under it take, each file counted once however
    many links it has, or None when any of it changed after cutoff or could not be read.
    Links are not followed, and a missing path takes 0."""
    seen = set()
    total = 0

    def idle(entry) -> bool:
        nonlocal total
        stats = os.lstat(entry)
        if max(stats.st_mtime, stats.st_ctime) > cutoff:
            return False
        if (stats.st_dev, stats.st_ino) not in seen:
            seen.add((stats.st_dev, stats.st_ino))
            total += stats.st_blocks * 512
        return True

    try:
        if not idle(path):
            return None
    except FileNotFoundError:
        return 0
    except OSError:
        return None
    if not path.is_dir() or path.is_symlink():
        return total
    unreadable = []
    try:
        for folder, dirs, files in os.walk(path, onerror=unreadable.append):
            for name in dirs + files:
                if not idle(os.path.join(folder, name)):
                    return None
    except OSError:
        # Something vanished or became unreadable mid-walk: not idle.
        return None
    return None if unreadable else total


class SweepStopped(Exception):
    """The sweep reached its time limit. in_place says a folder that could not be moved
    to the trash was left half removed."""

    def __init__(self, in_place: bool = False):
        super().__init__("stopped at the sweep time limit")
        self.in_place = in_place


@dataclass
class Limit:
    """The sweep's deadline on clock; reached records that it stopped a sweep."""

    deadline: float = float("inf")
    clock: Callable[[], float] = time.monotonic
    reached: bool = False

    def passed(self) -> bool:
        if self.clock() >= self.deadline:
            self.reached = True
        return self.reached

    def check(self) -> None:
        if self.passed():
            raise SweepStopped()


def remove_tree(path: Path, limit: Limit) -> None:
    """Remove a file or a folder of this user's own scratch, first giving back the
    owner's access to any folder in it that lacks it (Go module caches are read-only, for
    one). The limit is checked before each entry, so a large folder stops part way."""
    if path.is_symlink() or not path.is_dir():
        limit.check()
        path.unlink()
        return
    full = stat.S_IRWXU
    for folder, dirs, _files in os.walk(path):
        limit.check()
        if os.lstat(folder).st_mode & full != full:
            os.chmod(folder, os.lstat(folder).st_mode | full)
        for name in dirs:
            child = os.path.join(folder, name)
            mode = os.lstat(child).st_mode
            if stat.S_ISDIR(mode) and mode & full != full:
                os.chmod(child, mode | full)
    for folder, dirs, files in os.walk(path, topdown=False):
        for name in files + dirs:
            limit.check()
            child = os.path.join(folder, name)
            if name in dirs and not os.path.islink(child):
                os.rmdir(child)
            else:
                os.unlink(child)
    os.rmdir(path)


def to_trash(paths: list, trash: Path) -> tuple:
    """Move each path into a new folder in trash with one rename, so it leaves its place
    at once. Returns that folder (None when it could not be made, as on a full disk) and
    the paths that could not be moved (on another volume, say), to remove in place."""
    try:
        trash.mkdir(parents=True, exist_ok=True)
        bin_ = Path(tempfile.mkdtemp(dir=trash))
    except OSError:
        return None, list(paths)
    left = []
    for index, path in enumerate(paths):
        try:
            os.rename(path, bin_ / str(index))
        except OSError:
            left.append(path)
    return bin_, left


def discard(paths: list, trash: Path, limit: Limit) -> None:
    """Move paths to the trash, then remove them under the limit. Stopping while the
    trash is emptied leaves the rest there for the next sweep."""
    bin_, left = to_trash(paths, trash)
    for path in left:
        try:
            remove_tree(path, limit)
        except SweepStopped:
            raise SweepStopped(in_place=True) from None
    if bin_ is not None:
        remove_tree(bin_, limit)


def empty_trash(trash: Path, limit: Limit) -> None:
    """Finish removing what an earlier sweep moved to the trash and did not finish. An
    entry that fails does not keep the others; the first failure is raised at the end."""
    if not trash.is_dir():
        return
    failure = None
    for entry in sorted(trash.iterdir()):
        try:
            remove_tree(entry, limit)
        except OSError as error:
            failure = failure or error
    if failure:
        raise failure


def session_candidates(tmp_root: Path, projects: Path, cutoff: float) -> list:
    """Idle session folders under tmp_root with their sizes. The transcripts are checked
    first, since they are one file and one small folder while the scratch may be a large
    build tree. A project that cannot be listed is skipped."""
    candidates = []
    for project in sorted(tmp_root.iterdir()):
        if project.is_symlink() or not project.is_dir():
            continue
        transcripts = projects / project.name
        for session in subfolders(project):
            if not SESSION_ID.match(session.name):
                continue
            if (
                idle_size(transcripts / f"{session.name}.jsonl", cutoff) is None
                or idle_size(transcripts / session.name, cutoff) is None
            ):
                continue
            size = idle_size(session, cutoff)
            if size is not None:
                candidates.append((session, size))
    return candidates


def sweep_sessions(
    config: Config, run: Runner, now: datetime, dry_run: bool = False, clock: Callable[[], float] = time.monotonic,
    limit: Optional[Limit] = None,
) -> list:
    """Remove the scratch folders of idle Claude Code sessions (see the module doc).
    The process snapshot is taken once there is something to remove and renewed every
    few seconds, so a session resumed during a long sweep is still seen. Stops at the
    limit, returning what it removed so far."""
    limit = limit or Limit()
    if config.claude_tmp is None or not config.claude_tmp.is_dir():
        return []
    cutoff = (now - SWEEP_IDLE).timestamp()
    candidates = session_candidates(config.claude_tmp, config.claude_projects, cutoff)
    swept = []
    processes, taken = None, 0.0
    for session, size in candidates:
        if limit.passed():
            break
        if processes is None or clock() - taken > PROCESS_SNAPSHOT_SECONDS:
            processes, taken = running_processes(run, config.claude_sessions), clock()
            if processes is None:
                break
        transcripts = config.claude_projects / session.parent.name
        # The transcripts once more, just before removal: a session resumed since the
        # first look writes there first.
        if processes.use(session) or idle_size(transcripts / f"{session.name}.jsonl", cutoff) is None:
            continue
        error = None
        if not dry_run:
            try:
                discard([session], trash_dir(config), limit)
            except SweepStopped as stop:
                swept.append(Swept(str(session), size, str(stop) if stop.in_place else None))
                break
            except OSError as failure:
                error = str(failure)
        swept.append(Swept(str(session), size, error))
    return swept


def trash_dir(config: Config) -> Path:
    """Where swept folders wait to be removed: in the state folder, on the same volume as
    what is swept, so moving them there is one rename."""
    return config.state_dir / "trash"


def subfolders(folder: Path) -> list:
    """The real (not linked) folders directly in folder; none when it cannot be read."""
    try:
        return [entry for entry in sorted(folder.iterdir()) if entry.is_dir() and not entry.is_symlink()]
    except OSError:
        return []


def main_checkout(worktree: Path) -> Optional[Path]:
    """The repository a linked worktree belongs to, read from its `.git` file
    (`gitdir: <repo>/.git/worktrees/<name>`, the path absolute or relative to the
    worktree), or None."""
    try:
        line = (worktree / ".git").read_text().strip()
    except (OSError, UnicodeDecodeError):
        return None
    if not line.startswith("gitdir: "):
        return None
    gitdir = (worktree / line[len("gitdir: "):]).resolve()
    if gitdir.parent.name != "worktrees" or gitdir.parent.parent.name != ".git":
        return None
    return gitdir.parents[2]


def agent_worktrees(root: Path) -> list:
    """T3 worktrees, root/<project>/<name>, then the Claude Code worktrees,
    <repo>/.claude/worktrees/<name>, of the repositories they belong to."""
    worktrees = [tree for project in subfolders(root) for tree in subfolders(project)]
    repos = sorted({repo for repo in map(main_checkout, worktrees) if repo is not None})
    return worktrees + [tree for repo in repos for tree in subfolders(repo / ".claude" / "worktrees")]


def is_cargo_target(folder: Path) -> bool:
    if folder.name != "target" or folder.is_symlink():
        return False
    try:
        with open(folder / "CACHEDIR.TAG", "rb") as tag:
            return tag.read(len(CARGO_TAG)) == CARGO_TAG
    except OSError:
        return False


def cargo_targets(worktree: Path) -> list:
    """Cargo target folders in a worktree, such as `target` or `services/api/target`.
    Hidden folders and node_modules are not searched, nor is anything inside a target."""
    found = []
    for folder, dirs, _files in os.walk(worktree):
        path = Path(folder)
        if is_cargo_target(path):
            found.append(path)
            dirs.clear()
        elif len(path.relative_to(worktree).parts) >= TARGET_SEARCH_DEPTH:
            dirs.clear()
        else:
            dirs[:] = sorted(name for name in dirs if not name.startswith(".") and name != "node_modules")
    return found


def build_lock_files(target: Path) -> list:
    """Cargo's lock files in target's profile folders (target/debug,
    target/<triple>/release, target/llvm-cov-target/<triple>/debug, ...). A folder holding
    any of them is a profile folder and is not searched further."""
    found = []
    for folder, dirs, files in os.walk(target):
        names = sorted(CARGO_LOCKS.intersection(files))
        found += [Path(folder, name) for name in names]
        if names or len(Path(folder).relative_to(target).parts) >= LOCK_SEARCH_DEPTH:
            dirs.clear()
    return found


def take_build_locks(lock_files: list) -> Optional[list]:
    """Take every lock in lock_files without waiting and return their descriptors, or
    None, holding nothing, when a build holds any of them or one cannot be opened."""
    held = []
    try:
        for path in lock_files:
            descriptor = os.open(path, os.O_RDONLY)
            held.append(descriptor)
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        release(held)
        return None
    return held


def release(descriptors: list) -> None:
    for descriptor in descriptors:
        os.close(descriptor)


def removable(target: Path, lock_files: list) -> list:
    """What emptying target removes: everything in it but its CACHEDIR.TAG, the lock
    files and the folders that hold them. Those stay so that a build which starts
    meanwhile waits on the same locks, and finds the folder still tagged afterwards."""
    keep = {target / "CACHEDIR.TAG", *lock_files}
    holders = {folder for lock in lock_files for folder in lock.parents if target in folder.parents}
    entries, pending = [], [target]
    while pending:
        folder = pending.pop()
        for entry in sorted(folder.iterdir()):
            if entry in holders:
                pending.append(entry)
            elif entry not in keep:
                entries.append(entry)
    return sorted(entries)


def sweep_targets(
    config: Config, run: Runner, now: datetime, level: str = "low", dry_run: bool = False,
    clock: Callable[[], float] = time.monotonic, limit: Optional[Limit] = None,
) -> list:
    """Empty idle cargo target folders in agent worktrees (see the module doc). Each one's
    build locks are taken first and held to the end, so its idleness is read while no
    build can start in it. The process snapshot is taken only once an idle folder turns
    up, and renewed every few seconds. The entries move to the trash while the locks are
    held, so the folder is empty at once; they are removed after. Stops at the limit,
    returning what it emptied so far."""
    limit = limit or Limit()
    if config.worktrees is None or not config.worktrees.is_dir():
        return []
    cutoff = (now - TARGET_IDLE.get(level, TARGET_IDLE["low"])).timestamp()
    swept = []
    processes, taken = None, 0.0
    for worktree in agent_worktrees(config.worktrees):
        for target in cargo_targets(worktree):
            if limit.passed():
                return swept
            lock_files = build_lock_files(target)
            held = take_build_locks(lock_files)
            if held is None:
                continue
            try:
                size = idle_size(target, cutoff)
                if not size:
                    continue
                try:
                    entries = removable(target, lock_files)
                except OSError:
                    continue
                if not entries:
                    continue
                if processes is None or clock() - taken > PROCESS_SNAPSHOT_SECONDS:
                    # Session ids play no part here, so Claude Code's registry is not read.
                    processes, taken = running_processes(run, None), clock()
                    if processes is None:
                        return swept
                if processes.inside(target):
                    continue
                error = None
                if not dry_run:
                    try:
                        discard(entries, trash_dir(config), limit)
                    except SweepStopped as stop:
                        swept.append(Swept(str(target), size, str(stop) if stop.in_place else None, "target"))
                        return swept
                    except OSError as failure:
                        error = str(failure)
                swept.append(Swept(str(target), size, error, "target"))
            finally:
                release(held)
    return swept


def sweep(
    config: Config, run: Runner, now: datetime, level: str = "low", dry_run: bool = False,
    clock: Callable[[], float] = time.monotonic, trash_only: bool = False,
) -> tuple:
    """What earlier sweeps left in the trash, then (unless trash_only) idle session
    scratch, then idle cargo target folders, all within config.sweep_minutes. Returns what they removed, a
    failure record for each step that raised, and a `sweep_stopped` record or None; one
    step failing does not stop the next or lose what it removed."""
    limit = Limit(clock() + config.sweep_minutes * 60, clock)
    swept, failures = [], []

    def empty() -> list:
        empty_trash(trash_dir(config), limit)
        return []

    steps = (
        ("trash", empty),
        ("sessions", lambda: sweep_sessions(config, run, now, dry_run, limit=limit)),
        ("targets", lambda: sweep_targets(config, run, now, level, dry_run, limit=limit)),
    )
    for name, step in steps:
        if (dry_run and name == "trash") or (trash_only and name != "trash"):
            continue
        try:
            swept += step()
        except SweepStopped:
            pass
        except OSError as error:
            failures.append(
                {"at": now.isoformat(timespec="seconds"), "event": "sweep_failed", "sweep": name, "error": str(error)}
            )
        if limit.reached:
            break
    stopped = None
    if limit.reached:
        stopped = {"at": now.isoformat(timespec="seconds"), "event": "sweep_stopped", "limit_minutes": config.sweep_minutes}
    return swept, failures, stopped


def format_size(size: int) -> str:
    return f"{size / 1e9:.1f} GB" if size >= 1e9 else f"{size / 1e6:.0f} MB"


def sweep_note(swept: list) -> str:
    removed = [item for item in swept if item.error is None]
    if not removed:
        return ""
    sessions = sum(1 for item in removed if item.kind == "session")
    targets = len(removed) - sessions
    parts = []
    if sessions:
        parts.append(f"{sessions} idle Claude Code session scratch folder{'s' if sessions != 1 else ''}")
    if targets:
        parts.append(f"{targets} idle Rust target folder{'s' if targets != 1 else ''} in agent worktrees")
    return (
        f"The monitor removed {' and '.join(parts)} "
        f"(about {format_size(sum(item.bytes for item in removed))})."
    )


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


def sweep_record(swept: list, now: datetime) -> dict:
    return {
        "at": now.isoformat(timespec="seconds"),
        "event": "swept",
        "freed_gb": round(sum(item.bytes for item in swept if item.error is None) / 1e9, 2),
        "removed": [item.path for item in swept if item.error is None],
        "errors": {item.path: item.error for item in swept if item.error},
    }


def log(config: Config, record: dict) -> None:
    append_event(config.state_dir, record)
    print(json.dumps(record, ensure_ascii=False))


def run_check(
    config: Config, run: Runner, measure: Callable[[], float], now: datetime,
    clock: Callable[[], float] = time.monotonic,
) -> int:
    """Alert on the reading first, so a slow sweep never delays it, then sweep within the
    time limit and say what went."""
    free = measure()
    state_path = config.state_dir / "state.json"
    state, record = check(free, load_state(state_path), now, config, run)
    save_state(state_path, state)
    failed = False
    if record is not None:
        log(config, record)
        failed = bool(record.get("t3_error") or record.get("notify_error"))
    if config.claude_tmp or config.worktrees:
        # A sweep that fails must not stop the rest of the run. While space is ok it only
        # finishes what an earlier sweep left in the trash.
        swept, failures, stopped = sweep(config, run, now, state.level, clock=clock, trash_only=state.level == "ok")
        for failure in failures:
            failed = True
            log(config, failure)
        if swept:
            removed = sweep_record(swept, now)
            log(config, removed)
            failed = failed or bool(removed["errors"])
            note = sweep_note(swept)
            if note and stopped:
                note += " It reached its time limit; the next sweep finishes the deletion."
            if note:
                failed = bool(notify(run, config, "Disk space: idle build output removed", note)) or failed
        if stopped:
            log(config, stopped)
    return 1 if failed else 0


def run_sweep(config: Config, run: Runner, now: datetime, dry_run: bool) -> int:
    swept, failures, stopped = sweep(config, run, now, "low", dry_run)
    if not dry_run:
        for failure in failures:
            append_event(config.state_dir, failure)
        if swept:
            append_event(config.state_dir, sweep_record(swept, now))
        if stopped:
            append_event(config.state_dir, stopped)
    print(json.dumps(
        {
            "dry_run": dry_run,
            "freed_gb": round(sum(item.bytes for item in swept if item.error is None) / 1e9, 2),
            "sessions": [asdict(item) for item in swept if item.kind == "session"],
            "targets": [asdict(item) for item in swept if item.kind == "target"],
            "failures": failures,
            "stopped": stopped is not None,
        },
        indent=2,
        ensure_ascii=False,
    ))
    return 1 if failures or any(item.error for item in swept) else 0

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
    uv: str, script: Path, state_dir: Path, low_gb: float, critical_gb: float,
    sweep_minutes: float = DEFAULT_SWEEP_MINUTES,
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
            "--sweep-minutes",
            f"{sweep_minutes:g}",
        ],
        "StartInterval": INTERVAL_SECONDS,
        "RunAtLoad": True,
        # Not Background: macOS throttles a background job's disk I/O and CPU while other
        # work runs, and under parallel builds that made one sweep take 20 minutes.
        "ProcessType": "Standard",
        "EnvironmentVariables": {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"},
        "StandardOutPath": str(state_dir / "launchd.log"),
        "StandardErrorPath": str(state_dir / "launchd.log"),
    }


def run_install(run: Runner, dry_run: bool, low_gb: float, critical_gb: float, sweep_minutes: float) -> int:
    uv = shutil.which("uv")
    if uv is None:
        print("uv is not on PATH; install it first.", file=sys.stderr)
        return 1
    agent = launch_agent(
        str(Path(uv).resolve()), Path(__file__).resolve(), DEFAULT_STATE_DIR, low_gb, critical_gb, sweep_minutes
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


def positive(value: str) -> float:
    number = float(value)
    if not number > 0:
        raise argparse.ArgumentTypeError(f"must be above 0: {value}")
    return number


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
        add_sweep(command)

    def add_sweep(command: argparse.ArgumentParser) -> None:
        command.add_argument("--claude-tmp", type=Path, default=DEFAULT_CLAUDE_TMP)
        command.add_argument("--claude-projects", type=Path, default=DEFAULT_CLAUDE_PROJECTS)
        command.add_argument("--claude-sessions", type=Path, default=DEFAULT_CLAUDE_SESSIONS)
        command.add_argument(
            "--worktrees", type=Path, default=DEFAULT_WORKTREES,
            help="T3 worktree folder whose idle cargo target folders are swept",
        )
        command.add_argument(
            "--no-sweep", action="store_true", help="never remove session or target folders"
        )
        add_sweep_minutes(command)

    def add_sweep_minutes(command: argparse.ArgumentParser) -> None:
        command.add_argument(
            "--sweep-minutes", type=positive, default=DEFAULT_SWEEP_MINUTES,
            help="stop a sweep after this many minutes; the next one goes on",
        )

    check_command = commands.add_parser("check", help="measure once and alert if needed")
    add_common(check_command)
    check_command.add_argument(
        "--free-gb", type=float,
        help="use this reading instead of measuring (for testing); never sweeps",
    )
    add_common(commands.add_parser("test", help="send a test alert through both channels"))
    add_common(commands.add_parser("status", help="show the reading, state and agent"))
    install = commands.add_parser("install", help="write and load the LaunchAgent")
    install.add_argument("--dry-run", action="store_true", help="print the plist only")
    install.add_argument("--low-gb", type=float, default=DEFAULT_LOW_GB)
    install.add_argument("--critical-gb", type=float, default=DEFAULT_CRITICAL_GB)
    add_sweep_minutes(install)
    commands.add_parser("uninstall", help="unload and remove the LaunchAgent")
    sweep_command = commands.add_parser(
        "sweep", help="remove idle session scratch and worktree target folders now"
    )
    sweep_command.add_argument("--dry-run", action="store_true", help="list them without removing")
    sweep_command.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    add_sweep(sweep_command)

    args = parser.parse_args(argv)
    if args.command not in ("uninstall", "sweep") and args.critical_gb >= args.low_gb:
        parser.error("--critical-gb must be below --low-gb")
    return args


def main(argv: Optional[list] = None, run: Runner = run_command, now: Optional[datetime] = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    now = now or datetime.now(timezone.utc)
    if args.command == "install":
        return run_install(run, args.dry_run, args.low_gb, args.critical_gb, args.sweep_minutes)
    if args.command == "uninstall":
        return run_uninstall(run)
    # A simulated reading never sweeps: it must not touch real folders.
    simulated = getattr(args, "free_gb", None) is not None
    claude_tmp = None if args.no_sweep or simulated else args.claude_tmp
    worktrees = None if args.no_sweep or simulated else args.worktrees
    if args.command == "sweep":
        if claude_tmp is None:
            return 0
        config = Config(
            state_dir=args.state_dir,
            claude_tmp=claude_tmp,
            claude_projects=args.claude_projects,
            claude_sessions=args.claude_sessions,
            worktrees=worktrees,
            sweep_minutes=args.sweep_minutes,
        )
        return run_sweep(config, run, now, args.dry_run)
    config = Config(
        volume=args.volume,
        low_gb=args.low_gb,
        critical_gb=args.critical_gb,
        state_dir=args.state_dir,
        t3=None if args.no_t3 else args.t3,
        t3_project=args.t3_project,
        osascript=None if args.no_notify else args.osascript,
        claude_tmp=claude_tmp,
        claude_projects=args.claude_projects,
        claude_sessions=args.claude_sessions,
        worktrees=worktrees,
        sweep_minutes=args.sweep_minutes,
    )
    if args.command == "check":
        measure = (lambda: args.free_gb) if simulated else (lambda: free_gb(config.volume))
        return run_check(config, run, measure, now)
    if args.command == "test":
        return run_test(config, run, now)
    return run_status(config, run)


if __name__ == "__main__":
    sys.exit(main())

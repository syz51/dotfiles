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

`daily` runs proactive maintenance regardless of free space (scheduled once a day
through `install-daily` / `com.syz51.disk-space-daily`): it finishes trash, sweeps
idle Claude Code session scratch (>=24 hours) and idle Cargo `target/` folders in
agent worktrees (>=24 hours), removes clean merged T3 worktrees (>=48 hours idle,
no open files, no active or recent T3 thread, tip reachable from a remote base
ref), drops older duplicate Playwright browser revisions (>=24 hours idle), and
runs safe tool cache cleanups (`uv cache prune`, `brew cleanup --prune=14 -s`,
and `bun pm cache rm` when the Bun install cache exceeds its cap and no install
is running). A non-blocking `sweep.lock` (recording the holder PID and recovering
stale locks left by dead PIDs) keeps overlapping runs from colliding.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import inspect
import json
import os
import plistlib
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterator, Optional

HOME = Path.home()
LABEL = "com.syz51.disk-space-alert"
DAILY_LABEL = "com.syz51.disk-space-daily"
DEFAULT_VOLUME = "/System/Volumes/Data"
DEFAULT_LOW_GB = 30.0
DEFAULT_CRITICAL_GB = 20.0
HYSTERESIS_GB = 2.0
REMIND_AFTER = timedelta(hours=24)
INTERVAL_SECONDS = 600
# A sweep stops after this long, so the run ends and launchd can start the next check.
DEFAULT_SWEEP_MINUTES = 5.0
DEFAULT_DAILY_SWEEP_MINUTES = 10.0
DEFAULT_DAILY_HOUR = 4
DEFAULT_DAILY_MINUTE = 30
DEFAULT_STATE_DIR = HOME / ".local" / "state" / "disk-space-alert"
DEFAULT_T3 = HOME / ".t3" / "bin" / "t3"
DEFAULT_T3_PROJECT = HOME / ".t3" / "scratch"
DEFAULT_T3_DB = HOME / ".t3" / "userdata" / "statev2.sqlite"
DEFAULT_BUN_CACHE = HOME / ".bun" / "install" / "cache"
DEFAULT_BUN_CACHE_MAX_GB = 1.0
DEFAULT_PLAYWRIGHT_CACHE = HOME / "Library" / "Caches" / "ms-playwright"
DEFAULT_BREW_PRUNE_DAYS = 14
DEFAULT_WORKTREE_IDLE_HOURS = 48.0
DEFAULT_DAILY_TARGET_IDLE_HOURS = 24.0
DEFAULT_OSASCRIPT = "/usr/bin/osascript"
LAUNCH_AGENTS = HOME / "Library" / "LaunchAgents"
COMMAND_TIMEOUT_SECONDS = 90
UV_PRUNE_TIMEOUT_SECONDS = 300
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
PLAYWRIGHT_DIR = re.compile(r"^(?P<browser>[a-z][a-z0-9_]*)-(?P<rev>\d+)$")
ACTIVE_T3_RUN_STATUSES = ("queued", "preparing", "starting", "running", "waiting")
BREW_COMMAND = re.compile(r"(?:^|/|\s)brew(?:\.rb)?(?:\s|$)")
BUN_MUTATING_COMMAND = re.compile(
    r"(?:^|/|\s)(?:bunx(?:\s|$)|bun\s+(?:-\S+(?:\s+[^\s-]+)?\s+)*(?:install|i|add|a|update|up|ci|pm|x)(?:\s|$))"
)
DAILY_SEARCH_PATH = (
    f"{HOME / '.local' / 'bin'}:{HOME / '.bun' / 'bin'}"
    ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
)

Runner = Callable[[list, Optional[str]], subprocess.CompletedProcess]


def run_command(
    args: list,
    input_text: Optional[str] = None,
    timeout: int = COMMAND_TIMEOUT_SECONDS,
) -> subprocess.CompletedProcess:
    """Run a command, turning a missing program or a timeout into a failed result."""
    try:
        return subprocess.run(
            args,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError as error:
        return subprocess.CompletedProcess(args, 127, "", str(error))
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(
            args, TIMEOUT_EXIT, "", f"timed out after {timeout} seconds"
        )


def run_with_timeout(
    run: Runner, args: list, input_text: Optional[str], timeout: int
) -> subprocess.CompletedProcess:
    """Invoke run with a custom timeout when supported, falling back to the 2-arg Runner call."""
    if run is run_command:
        return run_command(args, input_text, timeout=timeout)
    try:
        params = inspect.signature(run).parameters
    except (TypeError, ValueError):
        params = {}
    if "timeout" in params or any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return run(args, input_text, timeout=timeout)
    return run(args, input_text)


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
    # Daily proactive cleanup paths; None leaves each step disabled unless enabled by `daily`.
    t3_db: Optional[Path] = None
    prune_worktrees: bool = True
    sweep_targets_enabled: bool = True
    bun_cache: Optional[Path] = None
    bun_cache_max_gb: float = DEFAULT_BUN_CACHE_MAX_GB
    playwright_cache: Optional[Path] = None
    uv_cache: Optional[Path] = None
    brew_prune_days: int = DEFAULT_BREW_PRUNE_DAYS
    worktree_idle_hours: float = DEFAULT_WORKTREE_IDLE_HOURS
    daily_target_idle_hours: float = DEFAULT_DAILY_TARGET_IDLE_HOURS
    search_path: str = DAILY_SEARCH_PATH


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


def worktree_gitdir(worktree: Path) -> Optional[Path]:
    """The resolved gitdir from a linked worktree's `.git` file, or None."""
    try:
        line = (worktree / ".git").read_text().strip()
    except (OSError, UnicodeDecodeError):
        return None
    if not line.startswith("gitdir: "):
        return None
    return (worktree / line[len("gitdir: "):]).resolve()


def main_checkout(worktree: Path) -> Optional[Path]:
    """The repository a linked worktree belongs to, read from its `.git` file
    (`gitdir: <repo>/.git/worktrees/<name>`, the path absolute or relative to the
    worktree), or None."""
    gitdir = worktree_gitdir(worktree)
    if gitdir is None or gitdir.parent.name != "worktrees" or gitdir.parent.parent.name != ".git":
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
    idle_window = (
        timedelta(hours=config.daily_target_idle_hours)
        if level == "daily"
        else TARGET_IDLE.get(level, TARGET_IDLE["low"])
    )
    cutoff = (now - idle_window).timestamp()
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
    limit: Optional[Limit] = None,
) -> tuple:
    """What earlier sweeps left in the trash, then (unless trash_only) idle session
    scratch, then idle cargo target folders, all within config.sweep_minutes. Returns what they removed, a
    failure record for each step that raised, and a `sweep_stopped` record or None; one
    step failing does not stop the next or lose what it removed."""
    limit = limit or Limit(clock() + config.sweep_minutes * 60, clock)
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
        if name == "targets" and not config.sweep_targets_enabled:
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


def pid_is_alive(pid: int) -> bool:
    """True when a process with pid exists on this host."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _parse_lock_owner(raw: bytes) -> Optional[dict]:
    text = raw.decode("utf-8", errors="replace").strip()
    if not text:
        return None
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if isinstance(data, int) and not isinstance(data, bool) and data > 0:
        return {"pid": data}
    if isinstance(data, dict):
        pid = data.get("pid")
        if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0:
            return data
    return None


def _read_lock_owner_fd(descriptor: int) -> Optional[dict]:
    try:
        os.lseek(descriptor, 0, os.SEEK_SET)
        return _parse_lock_owner(os.read(descriptor, 4096))
    except OSError:
        return None


def read_sweep_lock_owner(state_dir: Path) -> Optional[dict]:
    """Read the recorded owner metadata from sweep.lock, or None if missing/empty/invalid."""
    try:
        raw = (state_dir / "sweep.lock").read_bytes()[:4096]
    except OSError:
        return None
    return _parse_lock_owner(raw)


def _write_lock_owner_fd(descriptor: int) -> None:
    payload = (
        json.dumps(
            {
                "pid": os.getpid(),
                "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "started_epoch": round(time.time(), 3),
            }
        )
        + "\n"
    ).encode("utf-8")
    try:
        os.ftruncate(descriptor, 0)
        os.lseek(descriptor, 0, os.SEEK_SET)
        os.write(descriptor, payload)
    except OSError:
        pass


def _try_recover_stale_lock(state_dir: Path, lock_path: Path, orig_ino: int) -> Optional[int]:
    """Safely replace a sweep.lock whose recorded PID is dead while flock is still blocked.
    Takes an exclusive lock on sweep.lock.recover (which normal acquirers hold shared across
    open+flock+write) and re-verifies inode + dead PID before unlinking.
    Returns a newly locked descriptor populated with our PID on success, or None if an active run holds it."""
    recover_path = state_dir / "sweep.lock.recover"
    recover_fd = None
    try:
        recover_fd = os.open(recover_path, os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(recover_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        if recover_fd is not None:
            os.close(recover_fd)
        return None
    try:
        check_fd = None
        try:
            check_fd = os.open(lock_path, os.O_RDWR)
        except FileNotFoundError:
            check_fd = None
        if check_fd is not None:
            try:
                current_ino = os.fstat(check_fd).st_ino
                try:
                    fcntl.flock(check_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    fd = check_fd
                    check_fd = None
                    _write_lock_owner_fd(fd)
                    return fd
                except BlockingIOError:
                    if current_ino != orig_ino:
                        return None
                owner = _read_lock_owner_fd(check_fd)
                if owner is None or pid_is_alive(owner["pid"]):
                    return None
            finally:
                if check_fd is not None:
                    os.close(check_fd)
            try:
                os.unlink(lock_path)
            except FileNotFoundError:
                pass
        new_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(new_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(new_fd)
            return None
        _write_lock_owner_fd(new_fd)
        return new_fd
    except OSError:
        return None
    finally:
        try:
            fcntl.flock(recover_fd, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(recover_fd)


@contextlib.contextmanager
def sweep_lock(state_dir: Path) -> Iterator[bool]:
    """Acquire a non-blocking exclusive lock so overlapping check and daily runs do not race.
    Writes the holder PID to sweep.lock and recovers stale locks whose recorded PID is dead.
    Yields True when the lock is held, False when another live run already holds it."""
    lock_path = state_dir / "sweep.lock"
    recover_path = state_dir / "sweep.lock.recover"
    descriptor = None
    recover_fd = None
    recover_locked = False
    try:
        state_dir.mkdir(parents=True, exist_ok=True)
        # Hold a shared gate across open + flock + write-PID so stale recovery (which takes
        # LOCK_EX on the same gate) can never unlink sweep.lock under a live acquirer.
        recover_fd = os.open(recover_path, os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(recover_fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        recover_locked = True
        try:
            descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            _write_lock_owner_fd(descriptor)
        except BlockingIOError:
            owner = _read_lock_owner_fd(descriptor) if descriptor is not None else None
            try:
                orig_ino = os.fstat(descriptor).st_ino if descriptor is not None else None
            except OSError:
                orig_ino = None
            if descriptor is not None:
                os.close(descriptor)
                descriptor = None
            try:
                fcntl.flock(recover_fd, fcntl.LOCK_UN)
            except OSError:
                pass
            recover_locked = False
            os.close(recover_fd)
            recover_fd = None
            if owner is not None and not pid_is_alive(owner["pid"]) and orig_ino is not None:
                descriptor = _try_recover_stale_lock(state_dir, lock_path, orig_ino)
            if descriptor is None:
                yield False
                return
    except BlockingIOError:
        if descriptor is not None:
            os.close(descriptor)
            descriptor = None
        yield False
        return
    except OSError:
        if descriptor is not None:
            os.close(descriptor)
            descriptor = None
        # If state_dir cannot hold a lock file (e.g. a full disk or unwritable parent),
        # fall through rather than silently blocking emergency cleanup.
        yield True
        return
    finally:
        if recover_fd is not None:
            if recover_locked:
                try:
                    fcntl.flock(recover_fd, fcntl.LOCK_UN)
                except OSError:
                    pass
            os.close(recover_fd)
    try:
        yield True
    finally:
        try:
            os.ftruncate(descriptor, 0)
        except OSError:
            pass
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


def tree_size(path: Path) -> int:
    """Disk bytes allocated under path, counting each hard-linked inode once."""
    seen = set()
    total = 0

    def add(entry) -> None:
        nonlocal total
        try:
            stats = os.lstat(entry)
        except OSError:
            return
        if (stats.st_dev, stats.st_ino) not in seen:
            seen.add((stats.st_dev, stats.st_ino))
            total += stats.st_blocks * 512

    add(path)
    if path.is_symlink() or not path.is_dir():
        return total
    for folder, dirs, files in os.walk(path):
        for name in dirs + files:
            add(os.path.join(folder, name))
    return total


def parse_iso_utc(value: Optional[str]) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def held_t3_worktrees(db_path: Path, cutoff: datetime) -> Optional[frozenset]:
    """Resolved worktree paths held by T3 Code: any thread with an active run, a pending
    runtime request, or an updated_at newer than cutoff. Returns None if db_path cannot be read."""
    if not db_path.is_file():
        return None
    statuses = ", ".join(f"'{status}'" for status in ACTIVE_T3_RUN_STATUSES)
    query = f"""
    select
      json_extract(t.payload_json, '$.worktreePath') as wt,
      max(
        exists (
          select 1 from orchestration_v2_projection_runs r
          where r.thread_id = t.thread_id and r.status in ({statuses})
        )
        or exists (
          select 1 from orchestration_v2_projection_runtime_requests req
          where req.thread_id = t.thread_id and req.status = 'pending'
        )
      ) as active,
      max(t.updated_at) as updated_at
    from orchestration_v2_projection_threads t
    where json_extract(t.payload_json, '$.worktreePath') is not null
    group by wt
    """
    connection = None
    try:
        connection = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True, timeout=5.0)
        rows = connection.execute(query).fetchall()
    except (sqlite3.Error, OSError):
        return None
    finally:
        if connection is not None:
            connection.close()
    held = set()
    cutoff_utc = cutoff.astimezone(timezone.utc)
    for wt, active, updated_at in rows:
        if not isinstance(wt, str) or not wt:
            continue
        updated = parse_iso_utc(updated_at)
        if active or updated is None or updated > cutoff_utc:
            try:
                held.add(str(Path(wt).resolve()))
            except OSError:
                held.add(wt)
    return frozenset(held)


def worktree_base_refs(repo: Path, run: Runner) -> list:
    """Remote base refs whose ancestors are safe to drop (origin/HEAD and main checkout's upstream)."""
    refs = []
    for cmd in (
        ["git", "-C", str(repo), "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
        ["git", "-C", str(repo), "rev-parse", "--symbolic-full-name", "@{u}"],
    ):
        result = run(cmd, None)
        if result.returncode == 0:
            ref = result.stdout.strip()
            if ref and ref not in refs:
                refs.append(ref)
    return refs


def worktree_has_secret_env(worktree: Path) -> bool:
    """True when the worktree (at root or any non-vendor subdirectory) has any .env* file
    other than .env.example (unless .env is byte-for-byte identical to a sibling .env.example).
    Protects gitignored local secrets; unreadable directories fail closed."""
    unreadable = []
    skip_dirs = {".git", "node_modules", "target", ".venv"}
    for folder, dirs, files in os.walk(worktree, onerror=unreadable.append):
        dirs[:] = [name for name in dirs if name not in skip_dirs]
        folder_path = Path(folder)
        example = folder_path / ".env.example"
        for name in files:
            if name == ".env.example" or not (name == ".env" or name.startswith(".env.")):
                continue
            entry = folder_path / name
            if entry.is_symlink() or not entry.is_file():
                return True
            if name == ".env" and example.is_file():
                try:
                    if entry.read_bytes() == example.read_bytes():
                        continue
                except OSError:
                    return True
            return True
    return bool(unreadable)


def open_paths(run: Runner) -> Optional[tuple]:
    """Open file paths held by any process of this user, or None when unreadable."""
    lsof = run(["lsof", "-nP", "-u", str(os.getuid()), "-Fn"], None)
    if not lsof.stdout:
        return None
    return tuple(line[1:] for line in lsof.stdout.splitlines() if line.startswith("n/"))


def path_has_open_handles(folder: Path, paths: tuple) -> bool:
    real = str(folder.resolve())
    return any(path == real or path.startswith(real + "/") for path in paths)


def worktree_is_idle(worktree: Path, cutoff: float, run: Runner) -> bool:
    """Cheap idle check for a git worktree: root, .git, gitdir HEAD/index, top-level entries
    (excluding node_modules/target), and last commit timestamp must all be <= cutoff."""
    check_paths = [worktree, worktree / ".git"]
    gitdir = worktree_gitdir(worktree)
    if gitdir is not None:
        for name in ("HEAD", "index", "ORIG_HEAD"):
            candidate = gitdir / name
            if candidate.exists():
                check_paths.append(candidate)
    try:
        for entry in worktree.iterdir():
            if entry.name in ("node_modules", "target", ".git"):
                continue
            check_paths.append(entry)
    except OSError:
        return False
    for path in check_paths:
        try:
            stats = os.lstat(path)
        except OSError:
            return False
        if max(stats.st_mtime, stats.st_ctime) > cutoff:
            return False
    commit_time = run(["git", "-C", str(worktree), "log", "-1", "--format=%ct"], None)
    if commit_time.returncode != 0:
        return False
    try:
        if float(commit_time.stdout.strip()) > cutoff:
            return False
    except ValueError:
        return False
    return True


def sweep_merged_worktrees(
    config: Config, run: Runner, now: datetime, dry_run: bool = False,
    clock: Callable[[], float] = time.monotonic, limit: Optional[Limit] = None,
) -> list:
    """Remove clean T3 worktrees that have been idle for >= worktree_idle_hours, are not
    git-locked, hold no uncommitted changes or secret .env files, have no active/recent T3
    thread, open file handles or running process, and whose HEAD is already an ancestor of
    a remote base ref."""
    limit = limit or Limit()
    if not config.prune_worktrees or config.worktrees is None or not config.worktrees.is_dir():
        return []
    idle_delta = timedelta(hours=config.worktree_idle_hours)
    cutoff_dt = now - idle_delta
    cutoff = cutoff_dt.timestamp()
    held: frozenset = frozenset()
    if config.t3_db is not None:
        loaded = held_t3_worktrees(config.t3_db, cutoff_dt)
        if loaded is None:
            raise OSError(f"T3 state database unreadable: {config.t3_db}")
        held = loaded
    swept = []
    base_refs_cache: dict = {}
    processes, held_open, taken = None, None, 0.0
    for project in subfolders(config.worktrees):
        for tree in subfolders(project):
            if limit.passed():
                return swept
            resolved = str(tree.resolve())
            if resolved in held:
                continue
            gitdir = worktree_gitdir(tree)
            if gitdir is None or (gitdir / "locked").exists():
                continue
            repo = main_checkout(tree)
            if repo is None:
                continue
            if not worktree_is_idle(tree, cutoff, run):
                continue
            if worktree_has_secret_env(tree):
                continue
            status = run(["git", "-C", str(tree), "status", "--porcelain", "--untracked-files=normal"], None)
            if status.returncode != 0 or status.stdout.strip():
                continue
            head_res = run(["git", "-C", str(tree), "rev-parse", "HEAD"], None)
            if head_res.returncode != 0:
                continue
            head = head_res.stdout.strip()
            if not head:
                continue
            if repo not in base_refs_cache:
                base_refs_cache[repo] = worktree_base_refs(repo, run)
            refs = base_refs_cache[repo]
            if not refs:
                continue
            merged = any(
                run(["git", "-C", str(repo), "merge-base", "--is-ancestor", head, ref], None).returncode == 0
                for ref in refs
            )
            if not merged:
                continue
            if processes is None or held_open is None or clock() - taken > PROCESS_SNAPSHOT_SECONDS:
                processes = running_processes(run, None)
                held_open = open_paths(run) if processes is not None else None
                taken = clock()
                if processes is None or held_open is None:
                    return swept
            if processes.inside(tree) or path_has_open_handles(tree, held_open):
                continue
            size = tree_size(tree)
            error = None
            if not dry_run:
                removed = run(["git", "-C", str(repo), "worktree", "remove", str(tree)], None)
                if removed.returncode != 0:
                    error = (removed.stderr or removed.stdout).strip() or f"git worktree remove exit {removed.returncode}"
            swept.append(Swept(str(tree), size, error, "worktree"))
    return swept


def playwright_running(processes: Processes) -> bool:
    for line in processes.commands.splitlines():
        lowered = line.lower()
        if "disk_space_alert.py" in lowered:
            continue
        if "playwright" in lowered or "chrome-headless-shell" in lowered:
            return True
    return False


def sweep_playwright_cache(
    config: Config, run: Runner, now: datetime, dry_run: bool = False,
    clock: Callable[[], float] = time.monotonic, limit: Optional[Limit] = None,
) -> list:
    """Remove older duplicate browser revisions in ms-playwright (>=24h idle), keeping the
    newest numeric revision of each browser. Skips if Playwright or a headless shell runs."""
    limit = limit or Limit()
    root = config.playwright_cache
    if root is None or not root.is_dir() or limit.passed():
        return []
    groups: dict = {}
    for entry in subfolders(root):
        match = PLAYWRIGHT_DIR.match(entry.name)
        if match:
            groups.setdefault(match.group("browser"), []).append((int(match.group("rev")), entry))
    older = []
    for revisions in groups.values():
        if len(revisions) < 2:
            continue
        revisions.sort(key=lambda pair: pair[0])
        older.extend(folder for _rev, folder in revisions[:-1])
    if not older:
        return []
    cutoff = (now - SWEEP_IDLE).timestamp()
    candidates = []
    for folder in older:
        if limit.passed():
            return []
        size = idle_size(folder, cutoff)
        if size is not None:
            candidates.append((folder, size))
    if not candidates:
        return []
    swept = []
    processes, taken = None, 0.0
    for folder, size in candidates:
        if limit.passed():
            break
        if processes is None or clock() - taken > PROCESS_SNAPSHOT_SECONDS:
            processes, taken = running_processes(run, None), clock()
            if processes is None or playwright_running(processes):
                break
        if processes.inside(folder):
            continue
        error = None
        if not dry_run:
            try:
                discard([folder], trash_dir(config), limit)
            except SweepStopped as stop:
                swept.append(Swept(str(folder), size, str(stop) if stop.in_place else None, "playwright"))
                break
            except OSError as failure:
                error = str(failure)
        swept.append(Swept(str(folder), size, error, "playwright"))
    return swept


def uv_cache_in_use(config: Config, uv: str, run: Runner) -> bool:
    """True when a uv process (including an outer `uv run` without `--no-cache`) holds
    an advisory lock on uv's cache `.lock` file."""
    cache_dir = config.uv_cache
    if cache_dir is None:
        res = run([uv, "cache", "dir"], None)
        text = res.stdout.strip() if res.returncode == 0 else ""
        if text:
            cache_dir = Path(text)
    if cache_dir is None:
        return False
    lock_path = cache_dir / ".lock"
    if not lock_path.is_file():
        return False
    descriptor = None
    acquired = False
    try:
        descriptor = os.open(lock_path, os.O_RDONLY)
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        acquired = True
    except BlockingIOError:
        return True
    except OSError:
        return False
    finally:
        if descriptor is not None:
            if acquired:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_UN)
                except OSError:
                    pass
            os.close(descriptor)
    return False


def sweep_tool_caches(
    config: Config, run: Runner, dry_run: bool = False, limit: Optional[Limit] = None,
) -> list:
    """Run official, lock/process-safe cache cleanups: uv cache prune, brew cleanup, and
    bun pm cache rm (only when ~/.bun/install/cache exceeds bun_cache_max_gb)."""
    limit = limit or Limit()
    results = []

    uv = shutil.which("uv", path=config.search_path)
    if uv and not limit.passed():
        if uv_cache_in_use(config, uv, run):
            results.append({"tool": "uv", "skipped": "uv_cache_in_use", "ran": False, "error": None})
        elif dry_run:
            results.append({"tool": "uv", "action": "would run uv cache prune", "ran": False, "error": None})
        else:
            timeout = UV_PRUNE_TIMEOUT_SECONDS
            if limit.deadline != float("inf"):
                remaining = int(limit.deadline - limit.clock())
                if remaining <= 0:
                    limit.reached = True
                    timeout = 0
                else:
                    timeout = min(UV_PRUNE_TIMEOUT_SECONDS, remaining)
            if timeout > 0:
                res = run_with_timeout(run, [uv, "cache", "prune"], None, timeout)
                if res.returncode == TIMEOUT_EXIT:
                    warn = (res.stderr or res.stdout).strip() or f"timed out after {timeout} seconds"
                    results.append({
                        "tool": "uv",
                        "action": "uv cache prune",
                        "ran": True,
                        "error": None,
                        "warning": warn,
                    })
                else:
                    err = None if res.returncode == 0 else ((res.stderr or res.stdout).strip() or f"exit {res.returncode}")
                    results.append({"tool": "uv", "action": "uv cache prune", "ran": True, "error": err})

    brew = shutil.which("brew", path=config.search_path)
    if brew and not limit.passed():
        procs = running_processes(run, None)
        if procs is None:
            results.append({"tool": "brew", "skipped": "unreadable_processes", "ran": False, "error": None})
        elif BREW_COMMAND.search(procs.commands):
            results.append({"tool": "brew", "skipped": "brew_running", "ran": False, "error": None})
        else:
            args = [brew, "cleanup"] + (["-n"] if dry_run else []) + [f"--prune={config.brew_prune_days}", "-s"]
            res = run(args, None)
            err = None if res.returncode == 0 else ((res.stderr or res.stdout).strip() or f"exit {res.returncode}")
            results.append({"tool": "brew", "action": " ".join(args[1:]), "ran": not dry_run, "error": err})

    bun_cache = config.bun_cache
    bun = shutil.which("bun", path=config.search_path)
    if bun and bun_cache is not None and bun_cache.is_dir() and not limit.passed():
        size = tree_size(bun_cache)
        cap_bytes = config.bun_cache_max_gb * 1e9
        if size <= cap_bytes:
            results.append({"tool": "bun", "skipped": "below_cap", "bytes": size, "ran": False, "error": None})
        else:
            procs = running_processes(run, None)
            if procs is None:
                results.append({"tool": "bun", "skipped": "unreadable_processes", "bytes": size, "ran": False, "error": None})
            elif BUN_MUTATING_COMMAND.search(procs.commands):
                results.append({"tool": "bun", "skipped": "bun_install_running", "bytes": size, "ran": False, "error": None})
            elif dry_run:
                results.append({"tool": "bun", "action": "would run bun pm cache rm", "bytes": size, "ran": False, "error": None})
            else:
                res = run([bun, "pm", "cache", "rm"], None)
                err = None if res.returncode == 0 else ((res.stderr or res.stdout).strip() or f"exit {res.returncode}")
                results.append({"tool": "bun", "action": "bun pm cache rm", "bytes": size, "ran": True, "error": err})

    return results


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
        with sweep_lock(config.state_dir) as acquired:
            if not acquired:
                skipped = {"at": now.isoformat(timespec="seconds"), "event": "sweep_skipped", "reason": "lock_held"}
                owner = read_sweep_lock_owner(config.state_dir)
                if owner is not None:
                    skipped["holder_pid"] = owner["pid"]
                log(config, skipped)
                return 1 if failed else 0
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
    lock_ctx = contextlib.nullcontext(True) if dry_run else sweep_lock(config.state_dir)
    with lock_ctx as acquired:
        if not acquired:
            record = {"at": now.isoformat(timespec="seconds"), "event": "sweep_skipped", "reason": "lock_held"}
            owner = read_sweep_lock_owner(config.state_dir)
            if owner is not None:
                record["holder_pid"] = owner["pid"]
            append_event(config.state_dir, record)
            print(json.dumps(record, indent=2, ensure_ascii=False))
            return 0
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


def run_daily(
    config: Config, run: Runner, now: datetime, dry_run: bool = False,
    clock: Callable[[], float] = time.monotonic,
) -> int:
    """Proactive daily maintenance: finishes trash, sweeps idle Claude sessions (>=24h),
    idle Cargo targets (>=daily_target_idle_hours), clean merged T3 worktrees (>=worktree_idle_hours),
    older duplicate Playwright browsers, and safe tool caches. Quiet on success; notifies on failure."""
    lock_ctx = contextlib.nullcontext(True) if dry_run else sweep_lock(config.state_dir)
    with lock_ctx as acquired:
        if not acquired:
            record = {"at": now.isoformat(timespec="seconds"), "event": "daily_skipped", "reason": "lock_held"}
            owner = read_sweep_lock_owner(config.state_dir)
            if owner is not None:
                record["holder_pid"] = owner["pid"]
            append_event(config.state_dir, record)
            print(json.dumps(record, indent=2, ensure_ascii=False))
            return 0
        limit = Limit(clock() + config.sweep_minutes * 60, clock)
        swept, failures, stopped = sweep(config, run, now, "daily", dry_run, clock=clock, limit=limit)
        for name, step in (
            ("worktrees", lambda: sweep_merged_worktrees(config, run, now, dry_run, clock=clock, limit=limit)),
            ("playwright", lambda: sweep_playwright_cache(config, run, now, dry_run, clock=clock, limit=limit)),
        ):
            if limit.passed():
                break
            try:
                swept += step()
            except SweepStopped:
                pass
            except OSError as error:
                failures.append(
                    {"at": now.isoformat(timespec="seconds"), "event": "daily_failed", "step": name, "error": str(error)}
                )
        caches = []
        if not limit.passed():
            try:
                caches = sweep_tool_caches(config, run, dry_run=dry_run, limit=limit)
            except OSError as error:
                failures.append(
                    {"at": now.isoformat(timespec="seconds"), "event": "daily_failed", "step": "caches", "error": str(error)}
                )
        if limit.reached and stopped is None:
            stopped = {"at": now.isoformat(timespec="seconds"), "event": "sweep_stopped", "limit_minutes": config.sweep_minutes}

    freed_bytes = sum(item.bytes for item in swept if item.error is None)
    freed_bytes += sum(entry.get("bytes", 0) for entry in caches if entry.get("ran") and entry.get("error") is None)
    item_errors = {item.path: item.error for item in swept if item.error}
    cache_errors = {entry["tool"]: entry["error"] for entry in caches if entry.get("error")}
    cache_warnings = {entry["tool"]: entry["warning"] for entry in caches if entry.get("warning")}
    had_error = bool(failures or item_errors or cache_errors)
    summary = {
        "at": now.isoformat(timespec="seconds"),
        "event": "daily",
        "dry_run": dry_run,
        "freed_gb": round(freed_bytes / 1e9, 2),
        "sessions": [asdict(item) for item in swept if item.kind == "session"],
        "targets": [asdict(item) for item in swept if item.kind == "target"],
        "worktrees": [asdict(item) for item in swept if item.kind == "worktree"],
        "playwright": [asdict(item) for item in swept if item.kind == "playwright"],
        "caches": caches,
        "warnings": cache_warnings,
        "failures": failures,
        "stopped": stopped is not None,
    }
    if not dry_run:
        log_record = {
            "at": summary["at"],
            "event": "daily",
            "freed_gb": summary["freed_gb"],
            "removed": [item.path for item in swept if item.error is None],
            "caches": caches,
            "errors": {**item_errors, **cache_errors},
            "warnings": cache_warnings,
            "failures": failures,
            "stopped": summary["stopped"],
        }
        append_event(config.state_dir, log_record)
        if had_error:
            notify(
                run,
                config,
                "Disk space: daily cleanup had errors",
                "Some daily cleanup steps failed; see ~/.local/state/disk-space-alert/events.jsonl.",
            )
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 1 if had_error else 0

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


def daily_plist_path() -> Path:
    return LAUNCH_AGENTS / f"{DAILY_LABEL}.plist"


def launch_agent(
    uv: str, script: Path, state_dir: Path, low_gb: float, critical_gb: float,
    sweep_minutes: float = DEFAULT_SWEEP_MINUTES,
) -> dict:
    return {
        "Label": LABEL,
        "ProgramArguments": [
            uv,
            "run",
            "--no-cache",
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


def daily_launch_agent(
    uv: str, script: Path, state_dir: Path,
    hour: int = DEFAULT_DAILY_HOUR, minute: int = DEFAULT_DAILY_MINUTE,
    sweep_minutes: float = DEFAULT_DAILY_SWEEP_MINUTES,
    bun_cache_max_gb: float = DEFAULT_BUN_CACHE_MAX_GB,
    brew_prune_days: int = DEFAULT_BREW_PRUNE_DAYS,
) -> dict:
    return {
        "Label": DAILY_LABEL,
        "ProgramArguments": [
            uv,
            "run",
            "--no-cache",
            "--no-project",
            "--python",
            "3.11",
            "python",
            "-B",
            str(script),
            "daily",
            "--sweep-minutes",
            f"{sweep_minutes:g}",
            "--bun-cache-max-gb",
            f"{bun_cache_max_gb:g}",
            "--brew-prune-days",
            str(brew_prune_days),
        ],
        "StartCalendarInterval": {"Hour": hour, "Minute": minute},
        "RunAtLoad": False,
        "ProcessType": "Standard",
        "EnvironmentVariables": {"PATH": DAILY_SEARCH_PATH},
        "StandardOutPath": str(state_dir / "daily-launchd.log"),
        "StandardErrorPath": str(state_dir / "daily-launchd.log"),
    }


def install_plist(run: Runner, label: str, target: Path, agent: dict, dry_run: bool) -> int:
    if dry_run:
        sys.stdout.write(plistlib.dumps(agent).decode())
        return 0
    DEFAULT_STATE_DIR.mkdir(parents=True, exist_ok=True)
    LAUNCH_AGENTS.mkdir(parents=True, exist_ok=True)
    target.write_bytes(plistlib.dumps(agent))
    domain = f"gui/{os.getuid()}"
    run(["launchctl", "bootout", f"{domain}/{label}"], None)
    loaded = run(["launchctl", "bootstrap", domain, str(target)], None)
    if loaded.returncode != 0:
        target.unlink(missing_ok=True)
        print(f"launchctl bootstrap failed: {loaded.stderr.strip()}", file=sys.stderr)
        return 1
    print(f"Loaded {label} from {target}")
    return 0


def run_install(run: Runner, dry_run: bool, low_gb: float, critical_gb: float, sweep_minutes: float) -> int:
    uv = shutil.which("uv", path=DAILY_SEARCH_PATH) or shutil.which("uv")
    if uv is None:
        print("uv is not on PATH; install it first.", file=sys.stderr)
        return 1
    agent = launch_agent(
        str(Path(uv).resolve()), Path(__file__).resolve(), DEFAULT_STATE_DIR, low_gb, critical_gb, sweep_minutes
    )
    return install_plist(run, LABEL, plist_path(), agent, dry_run)


def run_install_daily(
    run: Runner, dry_run: bool, hour: int, minute: int,
    sweep_minutes: float, bun_cache_max_gb: float, brew_prune_days: int,
) -> int:
    uv = shutil.which("uv", path=DAILY_SEARCH_PATH) or shutil.which("uv")
    if uv is None:
        print("uv is not on PATH; install it first.", file=sys.stderr)
        return 1
    agent = daily_launch_agent(
        str(Path(uv).resolve()), Path(__file__).resolve(), DEFAULT_STATE_DIR,
        hour=hour, minute=minute, sweep_minutes=sweep_minutes,
        bun_cache_max_gb=bun_cache_max_gb, brew_prune_days=brew_prune_days,
    )
    return install_plist(run, DAILY_LABEL, daily_plist_path(), agent, dry_run)


def run_uninstall(run: Runner) -> int:
    run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"], None)
    plist_path().unlink(missing_ok=True)
    print(f"Removed {LABEL}; state in {DEFAULT_STATE_DIR} is kept.")
    return 0


def run_uninstall_daily(run: Runner) -> int:
    run(["launchctl", "bootout", f"gui/{os.getuid()}/{DAILY_LABEL}"], None)
    daily_plist_path().unlink(missing_ok=True)
    print(f"Removed {DAILY_LABEL}; state in {DEFAULT_STATE_DIR} is kept.")
    return 0


def run_status(config: Config, run: Runner) -> int:
    free = free_gb(config.volume)
    state = load_state(config.state_dir / "state.json")
    loaded = run(["launchctl", "print", f"gui/{os.getuid()}/{LABEL}"], None).returncode == 0
    daily_loaded = run(["launchctl", "print", f"gui/{os.getuid()}/{DAILY_LABEL}"], None).returncode == 0
    print(
        json.dumps(
            {
                "volume": config.volume,
                "free_gb": round(free, 2),
                "level_now": classify(free, state.level, config.low_gb, config.critical_gb),
                "thresholds_gb": {"low": config.low_gb, "critical": config.critical_gb},
                "state": asdict(state),
                "launch_agent_loaded": loaded,
                "daily_agent_loaded": daily_loaded,
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


def non_negative(value: str) -> float:
    number = float(value)
    if not number >= 0:
        raise argparse.ArgumentTypeError(f"must be 0 or above: {value}")
    return number


def non_negative_int(value: str) -> int:
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError(f"must be 0 or above: {value}")
    return number


def int_range(low: int, high: int) -> Callable[[str], int]:
    def check_value(value: str) -> int:
        number = int(value)
        if not low <= number <= high:
            raise argparse.ArgumentTypeError(f"must be between {low} and {high}: {value}")
        return number
    return check_value


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

    def add_sweep(command: argparse.ArgumentParser, default_minutes: float = DEFAULT_SWEEP_MINUTES) -> None:
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
        add_sweep_minutes(command, default_minutes)

    def add_sweep_minutes(command: argparse.ArgumentParser, default: float = DEFAULT_SWEEP_MINUTES) -> None:
        command.add_argument(
            "--sweep-minutes", type=positive, default=default,
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

    install_daily = commands.add_parser("install-daily", help="write and load the daily cleanup LaunchAgent")
    install_daily.add_argument("--dry-run", action="store_true", help="print the plist only")
    install_daily.add_argument("--hour", type=int_range(0, 23), default=DEFAULT_DAILY_HOUR)
    install_daily.add_argument("--minute", type=int_range(0, 59), default=DEFAULT_DAILY_MINUTE)
    add_sweep_minutes(install_daily, DEFAULT_DAILY_SWEEP_MINUTES)
    install_daily.add_argument("--bun-cache-max-gb", type=non_negative, default=DEFAULT_BUN_CACHE_MAX_GB)
    install_daily.add_argument("--brew-prune-days", type=non_negative_int, default=DEFAULT_BREW_PRUNE_DAYS)
    commands.add_parser("uninstall-daily", help="unload and remove the daily cleanup LaunchAgent")

    sweep_command = commands.add_parser(
        "sweep", help="remove idle session scratch and worktree target folders now"
    )
    sweep_command.add_argument("--dry-run", action="store_true", help="list them without removing")
    sweep_command.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    add_sweep(sweep_command)

    daily_command = commands.add_parser(
        "daily", help="run proactive daily cleanup of idle targets, sessions, merged worktrees and safe caches"
    )
    daily_command.add_argument("--dry-run", action="store_true", help="preview without removing")
    daily_command.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    daily_command.add_argument("--t3-db", type=Path, default=DEFAULT_T3_DB)
    daily_command.add_argument("--no-worktree-prune", action="store_true", help="skip removing merged T3 worktrees")
    daily_command.add_argument("--bun-cache", type=Path, default=DEFAULT_BUN_CACHE)
    daily_command.add_argument("--bun-cache-max-gb", type=non_negative, default=DEFAULT_BUN_CACHE_MAX_GB)
    daily_command.add_argument("--playwright-cache", type=Path, default=DEFAULT_PLAYWRIGHT_CACHE)
    daily_command.add_argument("--brew-prune-days", type=non_negative_int, default=DEFAULT_BREW_PRUNE_DAYS)
    daily_command.add_argument("--worktree-idle-hours", type=positive, default=DEFAULT_WORKTREE_IDLE_HOURS)
    daily_command.add_argument("--target-idle-hours", type=positive, default=DEFAULT_DAILY_TARGET_IDLE_HOURS)
    daily_command.add_argument("--osascript", default=DEFAULT_OSASCRIPT)
    daily_command.add_argument("--no-notify", action="store_true", help="skip macOS notifications")
    add_sweep(daily_command, DEFAULT_DAILY_SWEEP_MINUTES)

    args = parser.parse_args(argv)
    if args.command in ("check", "test", "status", "install") and args.critical_gb >= args.low_gb:
        parser.error("--critical-gb must be below --low-gb")
    return args


def main(argv: Optional[list] = None, run: Runner = run_command, now: Optional[datetime] = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    now = now or datetime.now(timezone.utc)
    if args.command == "install":
        return run_install(run, args.dry_run, args.low_gb, args.critical_gb, args.sweep_minutes)
    if args.command == "uninstall":
        return run_uninstall(run)
    if args.command == "install-daily":
        return run_install_daily(
            run, args.dry_run, args.hour, args.minute,
            args.sweep_minutes, args.bun_cache_max_gb, args.brew_prune_days,
        )
    if args.command == "uninstall-daily":
        return run_uninstall_daily(run)
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
    if args.command == "daily":
        config = Config(
            state_dir=args.state_dir,
            osascript=None if args.no_notify else args.osascript,
            claude_tmp=None if args.no_sweep else args.claude_tmp,
            claude_projects=args.claude_projects,
            claude_sessions=args.claude_sessions,
            worktrees=args.worktrees,
            sweep_targets_enabled=not args.no_sweep,
            sweep_minutes=args.sweep_minutes,
            t3_db=None if args.no_worktree_prune else args.t3_db,
            prune_worktrees=not args.no_worktree_prune,
            bun_cache=args.bun_cache,
            bun_cache_max_gb=args.bun_cache_max_gb,
            playwright_cache=args.playwright_cache,
            brew_prune_days=args.brew_prune_days,
            worktree_idle_hours=args.worktree_idle_hours,
            daily_target_idle_hours=args.target_idle_hours,
        )
        return run_daily(config, run, now, args.dry_run)
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

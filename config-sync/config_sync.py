#!/usr/bin/env python3
"""Keep this Mac's ~/.config checkout current with origin/main, and report what blocks it.

A LaunchAgent runs `check` every 30 minutes. It fetches origin/main and fast-forwards
the checkout when it is on main with no tracked changes and no commits of its own.
It never stashes, resets or merges: a checkout that is off main, has tracked changes,
has diverged or fails to fast-forward is left as it is and reported. Untracked files
are left alone; one that a fast-forward would overwrite makes the pull fail, which is
reported too. One change it undoes: a tracked `.json` file that is only reformatted (it
parses to the same JSON as HEAD, as when a Claude Code plugin install rewrites
claude/settings.json) gets its committed text back, so it does not block the pull.

After every check it also verifies the links that install the instructions from this
checkout (`~/.claude` and Codex's AGENTS.md); a copy instead of a link stops pulls from
reaching the agents.

A report goes to the board's feedback intake about the `config-sync` setup, once per
distinct set of problems: `board feedback --about config-sync --activity operate`, or
plain `board feedback` where the installed CLI lacks those options, or a macOS
notification when the board cannot be reached. A fetch that keeps failing (the Mac
offline, say) is reported only after 24 hours.

State lives in `~/.local/state/config-sync/state.json` and each check that pulled,
restored or reported adds a line to `events.jsonl` there. `status` prints the state, `install`
writes and loads the LaunchAgent.
"""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import shutil
import socket
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Optional

HOME = Path.home()
LABEL = "com.syz51.config-sync"
INTERVAL_SECONDS = 1800
FETCH_GRACE = timedelta(hours=24)
COMMAND_TIMEOUT_SECONDS = 120
DEFAULT_REPO = HOME / ".config"
DEFAULT_STATE_DIR = HOME / ".local" / "state" / "config-sync"
LAUNCH_AGENTS = HOME / "Library" / "LaunchAgents"
REMOTE = "origin"
BRANCH = "main"
# The board agent reports file as: launchd's environment names no session, and the board
# takes only t3, claude or codex agent ids (as the factory's friction capture does).
AGENT = "claude:config-sync"
SEARCH_PATH = f"{HOME / '.cargo' / 'bin'}:{HOME / '.local' / 'bin'}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

Runner = Callable[[list], subprocess.CompletedProcess]


def run_command(args: list) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=COMMAND_TIMEOUT_SECONDS, check=False)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(args, 124, "", f"timed out after {COMMAND_TIMEOUT_SECONDS}s")
    except OSError as error:
        return subprocess.CompletedProcess(args, 127, "", str(error))


def links(repo: Path) -> list:
    """(link, what it must resolve to): the paths that install instructions from the checkout."""
    return [
        (HOME / ".claude", repo / "claude"),
        (Path(os.environ.get("CODEX_HOME", HOME / ".codex")) / "AGENTS.md", repo / "codex" / "AGENTS.md"),
    ]


@dataclass
class State:
    reported: list = field(default_factory=list)
    fetch_failing_since: Optional[str] = None
    last_check: Optional[str] = None
    head: Optional[str] = None


def load_state(path: Path) -> State:
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError:
        return State()
    return State(**{key: data[key] for key in State.__dataclass_fields__ if key in data})


def save_state(path: Path, state: State) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(asdict(state), indent=2) + "\n")
    temp.replace(path)


def append_event(state_dir: Path, event: dict) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    with (state_dir / "events.jsonl").open("a") as log:
        log.write(json.dumps(event) + "\n")


def short(path: Path) -> str:
    text = str(path)
    return "~" + text[len(str(HOME)) :] if text.startswith(str(HOME) + os.sep) else text


@dataclass
class Outcome:
    problems: list  # [(kind, detail)]
    pulled: Optional[tuple] = None  # (old head, new head)
    fetch_failed: bool = False
    head: Optional[str] = None
    restored: list = field(default_factory=list)  # tracked paths put back to their committed text


def same_json(path: Path, committed: subprocess.CompletedProcess) -> bool:
    """Whether the file parses to the same JSON as the committed text (`git show HEAD:path`)."""
    if committed.returncode != 0:
        return False
    try:
        ours = json.loads(path.read_text())
        theirs = json.loads(committed.stdout)
    except (OSError, ValueError):
        return False
    # Canonical text, not ==: in Python 1 == 1.0 == true, which JSON readers tell apart.
    return json.dumps(ours, sort_keys=True) == json.dumps(theirs, sort_keys=True)


def sync(repo: Path, run: Runner) -> Outcome:
    """Fetch and fast-forward when safe; return the problems found."""
    git = lambda *args: run(["git", "-C", str(repo), *args])  # noqa: E731
    problems = []
    fetched = git("fetch", "--quiet", REMOTE, BRANCH)
    fetch_failed = fetched.returncode != 0
    branch = git("symbolic-ref", "--quiet", "--short", "HEAD").stdout.strip()
    head = git("rev-parse", "HEAD").stdout.strip()
    target = git("rev-parse", f"{REMOTE}/{BRANCH}").stdout.strip()
    changed = [line for line in git("status", "--porcelain", "--untracked-files=no").stdout.splitlines() if line.strip()]
    restored = []
    if branch == BRANCH:
        # Claude Code rewrites claude/settings.json in its own key order and layout on every
        # plugin install or update. Put the committed text back when the parsed JSON is
        # unchanged, so a reformat does not stop pulls; any real change stays and is reported.
        for line in changed:
            path = line[3:]
            if line[:2] == " M" and path.endswith(".json") and same_json(repo / path, git("show", f"HEAD:{path}")):
                if git("checkout", "--quiet", "--", path).returncode == 0:
                    restored.append(path)
    changed = [line[3:] for line in changed if line[3:] not in restored]
    if branch != BRANCH:
        problems.append(("off-main", f"the checkout is on {branch or 'a detached HEAD'}, not {BRANCH}"))
    if changed:
        listed = ", ".join(changed[:5]) + (f" and {len(changed) - 5} more" if len(changed) > 5 else "")
        problems.append(("dirty", f"{len(changed)} tracked file(s) changed: {listed}"))
    pulled = None
    if not problems and head and target and head != target:
        if git("merge-base", "--is-ancestor", "HEAD", f"{REMOTE}/{BRANCH}").returncode == 0:
            merged = git("merge", "--ff-only", "--quiet", f"{REMOTE}/{BRANCH}")
            if merged.returncode == 0:
                pulled = (head, target)
                head = target
            else:
                problems.append(("pull-failed", f"git merge --ff-only failed: {(merged.stderr or merged.stdout).strip()[:300]}"))
        else:
            ahead = git("rev-list", "--count", f"{REMOTE}/{BRANCH}..HEAD").stdout.strip()
            problems.append(("diverged", f"{ahead} local commit(s) are not on {REMOTE}/{BRANCH}"))
    for link, target_path in links(repo):
        if not target_path.exists():
            continue
        # The link may be the path itself or a folder above it (~/.codex linked whole).
        if link.resolve() != target_path.resolve():
            kind = "a copy" if link.exists() else "missing"
            problems.append(("link", f"{short(link)} is {kind}, not a link to {short(target_path)}"))
    return Outcome(problems, pulled, fetch_failed, head, restored)


def report_text(host: str, repo: Path, problems: list) -> str:
    lines = [f"config-sync on {host}: {short(repo)} is not kept current"]
    lines += [f"- {kind}: {detail}" for kind, detail in problems]
    lines.append("Nothing was changed; fix the checkout by hand, then the next check pulls.")
    return "\n".join(lines)


def report(run: Runner, board: Optional[str], text: str, signature: str) -> str:
    """File feedback, falling back to the plain command, then to a notification. Returns the channel."""
    if board:
        full = [board, "--agent", AGENT, "feedback", "--about", "config-sync", "--activity", "operate", "--signature", signature, "--", text]
        if run(full).returncode == 0:
            return "feedback"
        if run([board, "--agent", AGENT, "feedback", "--", f"[config-sync] {text}"]).returncode == 0:
            return "feedback-plain"
    title = text.splitlines()[0]
    script = f"display notification {json.dumps(text)} with title {json.dumps(title)}"
    run(["/usr/bin/osascript", "-e", script])
    return "notification"


def check(repo: Path, state_dir: Path, run: Runner, board: Optional[str], now: datetime, host: str) -> int:
    state_path = state_dir / "state.json"
    state = load_state(state_path)
    outcome = sync(repo, run)
    problems = list(outcome.problems)
    if outcome.fetch_failed:
        since = datetime.fromisoformat(state.fetch_failing_since) if state.fetch_failing_since else now
        state.fetch_failing_since = since.isoformat()
        if now - since >= FETCH_GRACE:
            problems.append(("fetch-failed", f"git fetch {REMOTE} {BRANCH} has failed since {since:%Y-%m-%d %H:%M} UTC"))
    else:
        state.fetch_failing_since = None
    event = {"at": now.isoformat(), "head": outcome.head}
    if outcome.pulled:
        event["pulled"] = list(outcome.pulled)
    if outcome.restored:
        event["restored"] = outcome.restored
    signature = sorted({f"{kind}: {detail}" for kind, detail in problems})
    if signature and signature != state.reported:
        kinds = "+".join(sorted({kind for kind, _ in problems}))
        event["reported"] = report(run, board, report_text(host, repo, problems), f"config-sync:{kinds}")
        event["problems"] = signature
    state.reported = signature
    state.last_check = now.isoformat()
    state.head = outcome.head
    save_state(state_path, state)
    if outcome.pulled or outcome.restored or "reported" in event:
        append_event(state_dir, event)
    for kind, detail in problems:
        print(f"{kind}: {detail}", file=sys.stderr)
    for path in outcome.restored:
        print(f"restored the committed text of {path} (same JSON)")
    if outcome.pulled:
        print(f"pulled {outcome.pulled[0][:12]}..{outcome.pulled[1][:12]}")
    return 0


def plist_path() -> Path:
    return LAUNCH_AGENTS / f"{LABEL}.plist"


def launch_agent(uv: str, script: Path, state_dir: Path) -> dict:
    return {
        "Label": LABEL,
        "ProgramArguments": [uv, "run", "--no-project", "--python", "3.11", "python", "-B", str(script), "check"],
        "StartInterval": INTERVAL_SECONDS,
        "RunAtLoad": True,
        "ProcessType": "Background",
        "EnvironmentVariables": {"PATH": SEARCH_PATH},
        "StandardOutPath": str(state_dir / "launchd.log"),
        "StandardErrorPath": str(state_dir / "launchd.log"),
    }


def run_install(run: Runner, dry_run: bool) -> int:
    uv = shutil.which("uv")
    if uv is None:
        print("uv is not on PATH; install it first.", file=sys.stderr)
        return 1
    agent = launch_agent(str(Path(uv).resolve()), Path(__file__).resolve(), DEFAULT_STATE_DIR)
    if dry_run:
        sys.stdout.write(plistlib.dumps(agent).decode())
        return 0
    DEFAULT_STATE_DIR.mkdir(parents=True, exist_ok=True)
    LAUNCH_AGENTS.mkdir(parents=True, exist_ok=True)
    plist_path().write_bytes(plistlib.dumps(agent))
    domain = f"gui/{os.getuid()}"
    run(["launchctl", "bootout", f"{domain}/{LABEL}"])
    loaded = run(["launchctl", "bootstrap", domain, str(plist_path())])
    if loaded.returncode != 0:
        print(f"launchctl bootstrap failed: {loaded.stderr.strip()}", file=sys.stderr)
        return 1
    print(f"Loaded {LABEL} from {plist_path()}")
    return 0


def run_uninstall(run: Runner) -> int:
    run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"])
    plist_path().unlink(missing_ok=True)
    print(f"Removed {LABEL}; state in {DEFAULT_STATE_DIR} is kept.")
    return 0


def run_status(state_dir: Path, run: Runner) -> int:
    loaded = run(["launchctl", "print", f"gui/{os.getuid()}/{LABEL}"]).returncode == 0
    print(json.dumps({"state": asdict(load_state(state_dir / "state.json")), "launch_agent_loaded": loaded}, indent=2))
    return 0


def parse_args(argv: list) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    check_parser = commands.add_parser("check", help="fetch, fast-forward when safe, and report problems")
    check_parser.add_argument("--repo", type=Path, default=DEFAULT_REPO)
    check_parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    install = commands.add_parser("install", help="write and load the LaunchAgent")
    install.add_argument("--dry-run", action="store_true", help="print the plist instead")
    commands.add_parser("uninstall", help="unload and remove the LaunchAgent")
    status = commands.add_parser("status", help="print the state and whether the agent is loaded")
    status.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    return parser.parse_args(argv)


def main(argv: Optional[list] = None, run: Runner = run_command, now: Optional[datetime] = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.command == "check":
        board = shutil.which("board", path=SEARCH_PATH)
        moment = now or datetime.now(timezone.utc)
        return check(args.repo.expanduser(), args.state_dir.expanduser(), run, board, moment, socket.gethostname().split(".")[0])
    if args.command == "install":
        return run_install(run, args.dry_run)
    if args.command == "uninstall":
        return run_uninstall(run)
    return run_status(args.state_dir.expanduser(), run)


if __name__ == "__main__":
    sys.exit(main())

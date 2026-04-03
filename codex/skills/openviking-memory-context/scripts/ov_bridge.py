#!/usr/bin/env python3
"""Bridge Codex skills to OpenViking.

This script provides a small, deterministic interface for:
- searching indexed OpenViking context
- recalling extracted memories
- reading and browsing viking:// URIs
- adding resources for later retrieval
- managing an explicit per-workspace session for memory commits
"""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib import error, request


@dataclass
class BackendInfo:
    mode: str
    config_path: str | None = None
    url: str | None = None
    api_key: str | None = None


def _print_json(data: Any) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2))


def _fail(message: str, *, detail: Any | None = None, exit_code: int = 1) -> None:
    payload: dict[str, Any] = {"ok": False, "error": message}
    if detail is not None:
        payload["detail"] = detail
    _print_json(payload)
    raise SystemExit(exit_code)


def _project_dir(raw: str | None) -> Path:
    return Path(raw or os.getcwd()).expanduser().resolve()


def _state_path(project_dir: Path, raw: str | None) -> Path:
    if raw:
        return Path(raw).expanduser().resolve()
    return project_dir / ".openviking" / "codex_state.json"


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return _load_json(path)
    except Exception:
        return {}


def _save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)


def _load_config(
    project_dir: Path, explicit: str | None
) -> tuple[Path | None, dict[str, Any]]:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser().resolve())

    env_path = os.environ.get("OPENVIKING_CONFIG_FILE")
    if env_path:
        candidates.append(Path(env_path).expanduser().resolve())

    candidates.append((project_dir / "ov.conf").resolve())
    candidates.append((Path.home() / ".openviking" / "ov.conf").resolve())

    seen: set[Path] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        if not candidate.exists():
            continue
        try:
            return candidate, _load_json(candidate)
        except Exception as exc:
            _fail(f"Failed to parse OpenViking config: {candidate}", detail=str(exc))

    return None, {}


def _health_check(url: str, timeout: float = 1.5) -> bool:
    try:
        with request.urlopen(f"{url.rstrip('/')}/health", timeout=timeout) as response:
            if response.status != 200:
                return False
            payload = json.loads(response.read().decode("utf-8"))
            return payload.get("status") == "ok"
    except (error.URLError, error.HTTPError, TimeoutError, OSError, ValueError):
        return False


def _detect_backend(
    project_dir: Path, config_path: Path | None, conf: dict[str, Any]
) -> BackendInfo:
    explicit_url = os.environ.get("OPENVIKING_URL", "").strip()
    api_key = os.environ.get("OPENVIKING_API_KEY", "").strip() or str(
        conf.get("server", {}).get("api_key", "") or ""
    )

    if explicit_url:
        if _health_check(explicit_url):
            return BackendInfo(
                mode="http",
                config_path=str(config_path) if config_path else None,
                url=explicit_url,
                api_key=api_key or None,
            )
        if config_path is None:
            _fail(
                "OPENVIKING_URL is set but the server is not healthy and no local ov.conf is available."
            )

    server_cfg = conf.get("server", {}) if isinstance(conf, dict) else {}
    host = str(server_cfg.get("host", "") or "").strip()
    port = server_cfg.get("port")

    if host and port:
        if host in {"0.0.0.0", "::", "[::]"}:
            host = "127.0.0.1"
        if host.startswith("http://") or host.startswith("https://"):
            base = host.rstrip("/")
            url = f"{base}:{port}" if ":" not in base.split("//", 1)[-1] else base
        else:
            url = f"http://{host}:{port}"
        if _health_check(url):
            return BackendInfo(
                mode="http",
                config_path=str(config_path) if config_path else None,
                url=url,
                api_key=api_key or None,
            )

    if config_path is None:
        _fail(
            "No usable OpenViking backend found. Provide OPENVIKING_URL or an ov.conf file at ./ov.conf or ~/.openviking/ov.conf."
        )

    return BackendInfo(mode="local", config_path=str(config_path))


class OVClient:
    def __init__(self, backend: BackendInfo):
        self.backend = backend
        self.client: Any = None

    def __enter__(self) -> "OVClient":
        try:
            from openviking import SyncHTTPClient, SyncOpenViking
        except Exception as exc:
            _fail(
                "OpenViking Python package is not available. Install it with `pip install openviking --upgrade`.",
                detail=str(exc),
            )

        if self.backend.mode == "http":
            self.client = SyncHTTPClient(
                url=self.backend.url, api_key=self.backend.api_key or None
            )
            self.client.initialize()
            return self

        os.environ["OPENVIKING_CONFIG_FILE"] = str(self.backend.config_path)
        self.client = SyncOpenViking()
        self.client.initialize()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.client is not None:
            try:
                self.client.close()
            except Exception:
                pass


def _auto_level(uri: str, requested: str) -> str:
    if requested != "auto":
        return requested
    return "overview" if uri.endswith("/") else "read"


def _serialize_find_result(result: Any) -> dict[str, Any]:
    if hasattr(result, "to_dict"):
        return result.to_dict()
    if isinstance(result, dict):
        return result
    return {"raw": str(result)}


def _context_preview(client: Any, uri: str, abstract: str, overview: str | None) -> str:
    if overview:
        return overview[:1200]
    if abstract:
        return abstract[:400]
    try:
        if uri.endswith("/"):
            return client.overview(uri)[:1200]
        return client.read(uri)[:1200]
    except Exception:
        return ""


def _active_session_id(
    client: Any, state: dict[str, Any], rotate: bool = False
) -> tuple[str, bool]:
    current = state.get("current_session_id")
    if current and not rotate:
        try:
            if client.session_exists(current):
                return current, False
        except Exception:
            pass

    created = client.create_session()
    session_id = created["session_id"]
    state["current_session_id"] = session_id
    state["last_session_id"] = session_id
    return session_id, True


def cmd_health(args: argparse.Namespace) -> None:
    project_dir = _project_dir(args.project_dir)
    config_path, conf = _load_config(project_dir, args.config)
    backend = _detect_backend(project_dir, config_path, conf)
    _print_json(
        {
            "ok": True,
            "backend": backend.mode,
            "url": backend.url,
            "config_path": backend.config_path,
        }
    )


def cmd_status(args: argparse.Namespace) -> None:
    project_dir = _project_dir(args.project_dir)
    state_file = _state_path(project_dir, args.state_file)
    state = _load_state(state_file)
    config_path, conf = _load_config(project_dir, args.config)
    backend = _detect_backend(project_dir, config_path, conf)
    _print_json(
        {
            "ok": True,
            "project_dir": str(project_dir),
            "state_file": str(state_file),
            "backend": backend.mode,
            "url": backend.url,
            "config_path": backend.config_path,
            "state": state,
        }
    )


def cmd_ensure_session(args: argparse.Namespace) -> None:
    project_dir = _project_dir(args.project_dir)
    state_file = _state_path(project_dir, args.state_file)
    state = _load_state(state_file)
    config_path, conf = _load_config(project_dir, args.config)
    backend = _detect_backend(project_dir, config_path, conf)

    with OVClient(backend) as ov:
        session_id, created = _active_session_id(ov.client, state, rotate=args.rotate)

    _save_state(state_file, state)
    _print_json(
        {
            "ok": True,
            "session_id": session_id,
            "created": created,
            "state_file": str(state_file),
        }
    )


def cmd_commit(args: argparse.Namespace) -> None:
    project_dir = _project_dir(args.project_dir)
    state_file = _state_path(project_dir, args.state_file)
    state = _load_state(state_file)
    session_id = state.get("current_session_id")
    if not session_id:
        _fail("No active OpenViking session is recorded for this workspace.")

    config_path, conf = _load_config(project_dir, args.config)
    backend = _detect_backend(project_dir, config_path, conf)
    with OVClient(backend) as ov:
        result = ov.client.commit_session(session_id)

    state["last_committed_session_id"] = session_id
    state["current_session_id"] = None
    _save_state(state_file, state)
    _print_json({"ok": True, "session_id": session_id, "result": result})


def cmd_remember(args: argparse.Namespace) -> None:
    project_dir = _project_dir(args.project_dir)
    state_file = _state_path(project_dir, args.state_file)
    state = _load_state(state_file)
    config_path, conf = _load_config(project_dir, args.config)
    backend = _detect_backend(project_dir, config_path, conf)

    with OVClient(backend) as ov:
        session_id, created = _active_session_id(ov.client, state, rotate=False)
        ov.client.add_message(session_id, "user", args.user_text)
        if args.assistant_text:
            ov.client.add_message(session_id, "assistant", args.assistant_text)
        result: dict[str, Any] | None = None
        if args.commit:
            result = ov.client.commit_session(session_id)
            state["last_committed_session_id"] = session_id
            state["current_session_id"] = None

    state["last_session_id"] = session_id
    _save_state(state_file, state)
    _print_json(
        {
            "ok": True,
            "session_id": session_id,
            "created_session": created,
            "committed": args.commit,
            "commit_result": result,
        }
    )


def cmd_search(args: argparse.Namespace) -> None:
    project_dir = _project_dir(args.project_dir)
    state = _load_state(_state_path(project_dir, args.state_file))
    config_path, conf = _load_config(project_dir, args.config)
    backend = _detect_backend(project_dir, config_path, conf)

    with OVClient(backend) as ov:
        session_id = state.get("current_session_id") if args.use_session else None
        result = ov.client.search(
            query=args.query,
            target_uri=args.target_uri or "",
            session_id=session_id,
            limit=args.limit,
            score_threshold=args.score_threshold,
        )

    _print_json({"ok": True, "result": _serialize_find_result(result)})


def cmd_recall(args: argparse.Namespace) -> None:
    project_dir = _project_dir(args.project_dir)
    config_path, conf = _load_config(project_dir, args.config)
    backend = _detect_backend(project_dir, config_path, conf)

    with OVClient(backend) as ov:
        user_result = ov.client.find(
            query=args.query,
            target_uri="viking://user/memories/",
            limit=args.top_k,
            score_threshold=args.score_threshold,
        )
        agent_result = ov.client.find(
            query=args.query,
            target_uri="viking://agent/memories/",
            limit=args.top_k,
            score_threshold=args.score_threshold,
        )

        entries: list[dict[str, Any]] = []
        for bucket in (
            getattr(user_result, "memories", []),
            getattr(agent_result, "memories", []),
        ):
            for item in bucket:
                entries.append(
                    {
                        "uri": item.uri,
                        "score": item.score,
                        "category": item.category,
                        "abstract": item.abstract,
                        "overview": item.overview,
                        "preview": _context_preview(
                            ov.client, item.uri, item.abstract, item.overview
                        ),
                    }
                )

    entries.sort(key=lambda item: item.get("score", 0.0), reverse=True)
    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for item in entries:
        uri = item["uri"]
        if uri in seen:
            continue
        seen.add(uri)
        deduped.append(item)
        if len(deduped) >= args.top_k:
            break

    _print_json({"ok": True, "query": args.query, "results": deduped})


def cmd_read(args: argparse.Namespace) -> None:
    project_dir = _project_dir(args.project_dir)
    config_path, conf = _load_config(project_dir, args.config)
    backend = _detect_backend(project_dir, config_path, conf)
    level = _auto_level(args.uri, args.level)

    with OVClient(backend) as ov:
        if level == "abstract":
            content = ov.client.abstract(args.uri)
        elif level == "overview":
            content = ov.client.overview(args.uri)
        else:
            content = ov.client.read(args.uri, offset=args.offset, limit=args.limit)

    _print_json({"ok": True, "uri": args.uri, "level": level, "content": content})


def cmd_ls(args: argparse.Namespace) -> None:
    project_dir = _project_dir(args.project_dir)
    config_path, conf = _load_config(project_dir, args.config)
    backend = _detect_backend(project_dir, config_path, conf)

    with OVClient(backend) as ov:
        items = ov.client.ls(
            args.uri,
            simple=args.simple,
            recursive=args.recursive,
            output="dict",
            abs_limit=args.abs_limit,
        )

    _print_json({"ok": True, "uri": args.uri, "items": items})


def cmd_add_resource(args: argparse.Namespace) -> None:
    project_dir = _project_dir(args.project_dir)
    config_path, conf = _load_config(project_dir, args.config)
    backend = _detect_backend(project_dir, config_path, conf)

    with OVClient(backend) as ov:
        result = ov.client.add_resource(
            path=args.path,
            to=args.to,
            parent=args.parent,
            reason=args.reason,
            instruction=args.instruction,
            wait=args.wait,
            timeout=args.timeout,
        )

    _print_json({"ok": True, "result": result})


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OpenViking bridge for Codex skills")
    parser.add_argument(
        "--project-dir", help="Workspace root. Defaults to current directory."
    )
    parser.add_argument("--config", help="Explicit ov.conf path.")
    parser.add_argument("--state-file", help="Explicit local state file path.")

    subparsers = parser.add_subparsers(dest="command", required=True)

    health = subparsers.add_parser("health", help="Show detected backend.")
    health.set_defaults(func=cmd_health)

    status = subparsers.add_parser(
        "status", help="Show backend and local session state."
    )
    status.set_defaults(func=cmd_status)

    ensure = subparsers.add_parser(
        "ensure-session", help="Create or reuse the workspace session."
    )
    ensure.add_argument(
        "--rotate", action="store_true", help="Force a fresh OpenViking session."
    )
    ensure.set_defaults(func=cmd_ensure_session)

    commit = subparsers.add_parser(
        "commit", help="Commit the active workspace session."
    )
    commit.set_defaults(func=cmd_commit)

    remember = subparsers.add_parser(
        "remember", help="Append distilled notes to the active session."
    )
    remember.add_argument(
        "--user-text", required=True, help="Durable summary of the user-side context."
    )
    remember.add_argument(
        "--assistant-text",
        help="Durable summary of the outcome, fix, or reusable lesson.",
    )
    remember.add_argument(
        "--commit", action="store_true", help="Commit immediately after adding notes."
    )
    remember.set_defaults(func=cmd_remember)

    search = subparsers.add_parser("search", help="Search indexed OpenViking context.")
    search.add_argument("--query", required=True)
    search.add_argument(
        "--target-uri", default="", help="Limit search to a viking:// subtree."
    )
    search.add_argument("--limit", type=int, default=8)
    search.add_argument("--score-threshold", type=float)
    search.add_argument(
        "--use-session",
        action="store_true",
        help="Include the active workspace session id when searching.",
    )
    search.set_defaults(func=cmd_search)

    recall = subparsers.add_parser(
        "recall", help="Recall memories from user and agent memory scopes."
    )
    recall.add_argument("--query", required=True)
    recall.add_argument("--top-k", type=int, default=5)
    recall.add_argument("--score-threshold", type=float)
    recall.set_defaults(func=cmd_recall)

    read = subparsers.add_parser("read", help="Read an abstract, overview, or file.")
    read.add_argument("--uri", required=True)
    read.add_argument(
        "--level", choices=["auto", "abstract", "overview", "read"], default="auto"
    )
    read.add_argument("--offset", type=int, default=0)
    read.add_argument("--limit", type=int, default=-1)
    read.set_defaults(func=cmd_read)

    ls_cmd = subparsers.add_parser("ls", help="List a viking:// directory.")
    ls_cmd.add_argument("--uri", required=True)
    ls_cmd.add_argument("--recursive", action="store_true")
    ls_cmd.add_argument("--simple", action="store_true")
    ls_cmd.add_argument("--abs-limit", type=int, default=256)
    ls_cmd.set_defaults(func=cmd_ls)

    add_resource = subparsers.add_parser(
        "add-resource", help="Index a repo, file, folder, or URL."
    )
    add_resource.add_argument(
        "--path", required=True, help="Source path, URL, or repo URL."
    )
    add_resource.add_argument(
        "--to", help="Explicit destination viking://resources/... URI."
    )
    add_resource.add_argument(
        "--parent", help="Parent URI if using parent-based placement."
    )
    add_resource.add_argument("--reason", default="")
    add_resource.add_argument("--instruction", default="")
    add_resource.add_argument("--wait", action="store_true")
    add_resource.add_argument("--timeout", type=float, default=300.0)
    add_resource.set_defaults(func=cmd_add_resource)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

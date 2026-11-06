#!/usr/bin/env python3
"""List idle T3 Code subagent threads whose parent or root thread is settled.

T3 Code does not settle a thread's subagent children when the thread is settled.
This script finds the children that a cascade would settle, so a scheduled T3 task
can settle them through the supported `t3_thread_organize` tool. It opens the T3
state database read-only and never changes it.

A thread is listed when all of these hold:
- it is a subagent child that is not deleted, archived or settled, and nobody
  explicitly unsettled it;
- its parent or root thread is settled or archived;
- it, its parent and its root have no queued, preparing, starting, running or
  waiting run;
- its subagent record is finished and the run that spawned it is not active;
- it has no pending request.

Each call prints the listed thread ids, one per line, and with `--log` appends one
JSON line describing the call to that file.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_DB = Path.home() / ".t3" / "userdata" / "statev2.sqlite"

ACTIVE_RUN_STATUSES = ("queued", "preparing", "starting", "running", "waiting")
FINISHED_SUBAGENT_STATUSES = ("completed", "failed", "cancelled", "interrupted")


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


CANDIDATES_SQL = f"""
with
active_runs as (
  select run_id, thread_id from orchestration_v2_projection_runs
  where status in ({_sql_list(ACTIVE_RUN_STATUSES)})
),
threads as (
  select
    thread_id,
    archived_at,
    deleted_at,
    json_extract(payload_json, '$.settledAt') as settled_at,
    json_extract(payload_json, '$.settledOverride') as settled_override,
    json_extract(payload_json, '$.lineage.relationshipToParent') as relationship,
    json_extract(payload_json, '$.lineage.parentThreadId') as parent_id,
    json_extract(payload_json, '$.lineage.rootThreadId') as root_id,
    json_extract(payload_json, '$.createdAt') as created_at
  from orchestration_v2_projection_threads
)
select child.thread_id
from threads as child
where child.relationship = 'subagent'
  and child.deleted_at is null
  and child.archived_at is null
  and child.settled_at is null
  and child.settled_override is null
  and exists (
    select 1 from threads as ancestor
    where ancestor.thread_id in (child.parent_id, child.root_id)
      and ancestor.thread_id <> child.thread_id
      and (ancestor.settled_at is not null or ancestor.archived_at is not null)
  )
  and not exists (
    select 1 from active_runs as run
    where run.thread_id in (child.thread_id, child.parent_id, child.root_id)
  )
  and not exists (
    select 1 from orchestration_v2_projection_subagents as subagent
    where subagent.child_thread_id = child.thread_id
      and (
        subagent.status not in ({_sql_list(FINISHED_SUBAGENT_STATUSES)})
        or subagent.run_id in (select run_id from active_runs)
      )
  )
  and not exists (
    select 1 from orchestration_v2_projection_runtime_requests as request
    where request.thread_id = child.thread_id and request.status = 'pending'
  )
order by child.created_at, child.thread_id
"""


def find_candidates(db_path: Path) -> list[str]:
    if not db_path.is_file():
        raise FileNotFoundError(f"T3 state database not found: {db_path}")
    connection = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        return [row[0] for row in connection.execute(CANDIDATES_SQL)]
    finally:
        connection.close()


def append_log(log_path: Path, phase: str, thread_ids: list[str]) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "phase": phase,
        "count": len(thread_ids),
        "threadIds": thread_ids,
    }
    with log_path.open("a", encoding="utf-8") as log:
        log.write(json.dumps(record) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="T3 state database")
    parser.add_argument("--log", type=Path, help="append a JSON line per call to this file")
    parser.add_argument(
        "--phase",
        default="plan",
        help="label for the log line, such as plan before settling and verify after",
    )
    args = parser.parse_args(argv)

    thread_ids = find_candidates(args.db)
    if args.log is not None:
        append_log(args.log, args.phase, thread_ids)
    for thread_id in thread_ids:
        print(thread_id)
    return 0


if __name__ == "__main__":
    sys.exit(main())

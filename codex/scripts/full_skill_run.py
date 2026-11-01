"""Source-input-bound installed-skill runs; no model is called when imported."""
import hashlib
import json
import os
from pathlib import Path
import stat


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def typed_tree_snapshot(root):
    """Inventory types and permissions as well as bytes, without following links."""
    result = {}
    for path in [root, *root.rglob('*')]:
        metadata = path.lstat()
        entry = {'kind': stat.S_IFMT(metadata.st_mode),
                 'mode': stat.S_IMODE(metadata.st_mode)}
        if stat.S_ISLNK(metadata.st_mode):
            entry['link'] = os.readlink(path)
        elif stat.S_ISREG(metadata.st_mode):
            entry['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        result[str(path.relative_to(root))] = entry
    return result


def skill_source_snapshot(path):
    metadata = path.lstat()
    return {'rootKind': stat.S_IFMT(metadata.st_mode),
            'rootMode': stat.S_IMODE(metadata.st_mode),
            'rootLink': os.readlink(path) if path.is_symlink() else None,
            'resolvedRoot': str(path.resolve()),
            'tree': typed_tree_snapshot(path.resolve())}


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)
    elif isinstance(value, dict):
        for child in value.values():
            yield from strings(child)


def source_input(records, instructions):
    return bool(instructions.strip()) and any(
        record.get('type') == 'response_item'
        and record.get('payload', {}).get('type') == 'message'
        and record['payload'].get('role') in ('user', 'developer', 'system')
        and any(instructions.strip() in text
                for text in strings(record['payload'].get('content')))
        for record in records)


def completed_turn(records):
    contexts = [(i, r.get('payload', {})) for i, r in enumerate(records)
                if r.get('type') == 'turn_context']
    starts = [(i, r.get('payload', {})) for i, r in enumerate(records)
              if r.get('type') == 'event_msg'
              and r.get('payload', {}).get('type') == 'task_started']
    if not contexts or not starts:
        return False
    ci, context = contexts[-1]
    si, start = starts[-1]
    turn = start.get('turn_id')
    if not isinstance(turn, str) or not turn or context.get('turn_id') != turn:
        return False
    for i, record in enumerate(records):
        p = record.get('payload', {})
        if (record.get('type') == 'event_msg'
                and p.get('type') in ('error', 'turn_aborted', 'task_failed', 'task_cancelled')
                and (p.get('turn_id') == turn
                     or (not p.get('turn_id') and i > min(ci, si)))):
            return False
    return any(r.get('type') == 'event_msg'
               and r.get('payload', {}).get('type') == 'task_complete'
               and r['payload'].get('turn_id') == turn
               for r in records[max(ci, si) + 1:])


def session_files(root):
    return {p for p in root.rglob('*.jsonl') if not p.is_symlink()} if root.is_dir() else set()


def parent_thread(meta):
    value = meta.get('source')
    for key in ('subagent', 'thread_spawn', 'parent_thread_id'):
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value if isinstance(value, str) and value else None


def owned_sources(root, before, fixture, reported_id):
    """Metadata establishes cleanup ownership, never completed-run evidence."""
    candidates = []
    for path in sorted(session_files(root) - before):
        try:
            with path.open() as stream:
                first = json.loads(stream.readline())
            meta = first.get('payload', {})
            if (first.get('type') == 'session_meta' and meta.get('cwd') == str(fixture)
                    and isinstance(meta.get('id'), str) and meta['id']):
                candidates.append((path, meta))
        except (OSError, ValueError, AttributeError, TypeError):
            continue
    roots = {reported_id} if isinstance(reported_id, str) and reported_id else set()
    roots.update(meta['id'] for _, meta in candidates
                 if not parent_thread(meta))
    while True:
        descendants = {meta['id'] for _, meta in candidates
                       if parent_thread(meta) in roots}
        expanded = roots | descendants
        if expanded == roots:
            break
        roots = expanded
    return [(path, meta) for path, meta in candidates if meta['id'] in roots]


def run_case(engine, case, output_dir, folders, executable, timeout=240,
             model=None, candidate=False):
    """Same engine runner interface, with ordinary syntax and persistent evidence."""
    from ordinary_trace import score_ordinary_trace
    if candidate:
        raise ValueError('Ordinary verification requires installed user configuration')
    directory = output_dir / case['id']
    directory.mkdir(mode=0o700)
    fixture = directory / 'fixture'
    fixture.mkdir()
    fixture = fixture.resolve()
    for name, content in case['files'].items():
        path = fixture / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    home = Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex')
    instructions_path = home / 'AGENTS.md'
    instructions = instructions_path.read_text()
    before_fixture = typed_tree_snapshot(fixture)
    before_skills = {name: skill_source_snapshot(path) for name, path in folders.items()}
    targets = engine.snapshot_targets(folders)
    (directory / 'targets.json').write_text(json.dumps(targets, indent=2) + '\n')
    (directory / 'case.json').write_text(json.dumps(case, indent=2) + '\n')
    sessions = home / 'sessions'
    before = session_files(sessions)
    parent_id = None
    source = []
    stdout = ''
    failures = []
    linked_children = []
    record = {'case': case['id'], 'invocation': case['invocation'],
              'configuration': 'installed-user-configuration',
              'ordinaryVerification': True, 'passed': False,
              'adapterWorkingDirectory': 'per-command runtime source evidence only',
              'globalAgentsSha256Before': digest(instructions)}
    try:
        command = [executable, 'exec', '--json', '--sandbox', 'read-only',
                   '--skip-git-repo-check', '-C', str(fixture),
                   '-c', 'sqlite_home=' + json.dumps(str(directory / 'state')),
                   '-c', 'log_dir=' + json.dumps(str(directory / 'logs'))]
        if model:
            command += ['--model', model]
        command += [case['prompt'] + engine.SAFETY]
        code, stdout, stderr, timed_out = engine.run_process(command, timeout)
        (directory / 'trace.jsonl').write_text(stdout)
        (directory / 'stderr.txt').write_text(stderr)
        for line in stdout.splitlines():
            try:
                event = json.loads(line)
                if event.get('type') == 'thread.started':
                    parent_id = event.get('thread_id')
                    break
            except (ValueError, AttributeError):
                pass
        record.update(exit_code=code, timed_out=timed_out)
        if code:
            failures.append('Codex exited unsuccessfully')
        if timed_out:
            failures.append('Codex timed out; process group terminated')
    except Exception as error:
        failures.append(type(error).__name__ + ': ' + str(error))
    finally:
        # Move only newly-created, metadata-owned transcripts. Even incomplete
        # tails are retained for inspection and cleaned from the user's store.
        for path, meta in owned_sources(sessions, before, fixture, parent_id):
            if parent_thread(meta):
                linked_children.append(meta['id'])
            destination = directory / ('source-' + digest(str(path))[:20] + '.jsonl')
            try:
                path.rename(destination)
            except OSError as error:
                failures.append('Owned transcript relocation failed: ' + str(error))
                continue
            if meta['id'] == parent_id:
                try:
                    source = [json.loads(line) for line in destination.read_text().splitlines() if line.strip()]
                    if any(not isinstance(r, dict)
                           or ('payload' in r and not isinstance(r['payload'], dict))
                           for r in source):
                        raise ValueError('Invalid source record shape')
                except (OSError, ValueError):
                    source = []
                    failures.append('Parent source transcript is malformed')
        input_proof = source_input(source, instructions)
        turn_proof = completed_turn(source)
        for name in case['forbidden']:
            if source_input(source, targets[name]['content']):
                failures.append('Forbidden guidance was present in source input: ' + name)
        try:
            from source_evidence import bind_command_cwds
            bindings = bind_command_cwds(stdout, source)
            record['commandCwds'] = bindings
            record.update(score_ordinary_trace(
                stdout, targets, case['required'], case['forbidden'], case['before'],
                files={str(fixture / name): text for name, text in case['files'].items()},
                cwd=None, command_cwds=bindings, home=str(Path.home())))
        except Exception as error:
            failures.append('Scoring failed: ' + type(error).__name__ + ': ' + str(error))
        if linked_children or any(
                record.get('type') == 'response_item'
                and record.get('payload', {}).get('type') in ('function_call', 'custom_tool_call')
                and record['payload'].get('name') in ('spawn_agent', 'delegate_task', 'mcp__t3_code__delegate_task')
                for record in source):
            failures.append('Direct-work skill evaluation unexpectedly delegated work')
        if not isinstance(parent_id, str) or not parent_id:
            failures.append('Missing CLI parent thread ID')
        if not source or source[0].get('payload', {}).get('id') != parent_id:
            failures.append('Matching owned parent source was not observed')
        if not input_proof:
            failures.append('Complete global instructions were not observed in source input')
        if not turn_proof:
            failures.append('Current source turn did not complete successfully')
        try:
            after_instructions = instructions_path.read_text()
            record['globalAgentsSha256After'] = digest(after_instructions)
            if after_instructions != instructions:
                failures.append('Global instructions changed during evaluation')
            if before_fixture != typed_tree_snapshot(fixture):
                failures.append('Read-only fixture changed')
            if any(before_skills[name] != skill_source_snapshot(path)
                   for name, path in folders.items()):
                failures.append('Skill source changed during evaluation')
        except OSError as error:
            failures.append('Input inspection failed: ' + str(error))
        result = record.get('result', {})
        record.update(sourceInput=input_proof, currentTurnCompleted=turn_proof,
                      linkedChildCount=len(linked_children),
                      parentThreadSha256=digest(parent_id) if isinstance(parent_id, str) else None,
                      completed=result.get('completed', False), reads=result.get('reads', []),
                      failures=list(result.get('failures', [])) + failures,
                      strictPassed=record.get('strictResult', {}).get('passed', False))
        record['passed'] = result.get('passed', False) and not failures
        (directory / 'result.json').write_text(json.dumps(record, indent=2) + '\n')
    return record

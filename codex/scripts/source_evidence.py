"""Bind CLI command events to runtime-recorded directories without guessing.

This module interprets data only. It never executes captured commands, reads
referenced paths, or infers the working directory from the fixture or output.
"""
import json
import re
import shlex
from urllib.parse import unquote, urlsplit


def _payload(record):
    value = record.get('payload')
    return value if isinstance(value, dict) else {}


def _identifier(value):
    return isinstance(value, str) and bool(value) and value == value.strip()


def _potential_tool_record(record):
    """One conservative classifier for all phases; unknown kinds are not inert."""
    kind = record.get('type')
    p = _payload(record)
    if kind == 'response_item':
        if p.get('type') == 'message':
            content = p.get('content')
            plain = (isinstance(content, str) or isinstance(content, list)
                     and all(isinstance(part, dict)
                             and part.get('type') in ('text', 'input_text', 'output_text')
                             for part in content))
            return p.get('role') not in ('user', 'developer', 'system', 'assistant') or not plain
        return p.get('type') not in ('reasoning', 'additional_tools')
    if kind == 'event_msg':
        if p.get('type') in ('task_started', 'task_complete', 'token_count', 'thread_settings_applied'):
            return False
        item = p.get('item')
        return not (p.get('type') in ('item_started', 'item_completed')
                    and isinstance(item, dict)
                    and item.get('type') in ('UserMessage', 'AgentMessage', 'Reasoning',
                                              'Plan', 'TodoList', 'ContextCompaction'))
    return kind not in ('session_meta', 'turn_context', 'token_usage_record', 'world_state')


def _phase(records, allow_child=False):
    if (not isinstance(records, list) or not records
            or any(not isinstance(r, dict)
                   or ('payload' in r and not isinstance(r['payload'], dict))
                   for r in records)):
        return None
    metadata = _payload(records[0])
    thread = metadata.get('id')
    source = metadata.get('source')
    if (records[0].get('type') != 'session_meta'
            or not _identifier(thread)
            or (not allow_child and isinstance(source, dict) and 'subagent' in source)):
        return None
    contexts = [(i, _payload(r)) for i, r in enumerate(records)
                if r.get('type') == 'turn_context']
    starts = [(i, _payload(r)) for i, r in enumerate(records)
              if r.get('type') == 'event_msg'
              and _payload(r).get('type') == 'task_started']
    if not contexts or not starts:
        return None
    ci, context = contexts[-1]
    si, start = starts[-1]
    turn = start.get('turn_id')
    if not _identifier(turn) or context.get('turn_id') != turn:
        return None
    for i, record in enumerate(records):
        p = _payload(record)
        if (record.get('type') == 'event_msg'
                and p.get('type') in ('error', 'turn_aborted', 'task_failed', 'task_cancelled')
                and (p.get('turn_id') == turn
                     or (not p.get('turn_id') and i > min(ci, si)))):
            return None
    completed = [i for i, r in enumerate(records)
                 if i > max(ci, si) and r.get('type') == 'event_msg'
                 and _payload(r).get('type') == 'task_complete'
                 and _payload(r).get('turn_id') == turn]
    return (thread, turn, max(ci, si), completed[0]) if len(completed) == 1 else None


def _cwd(value):
    if not isinstance(value, str) or not value.startswith('file://'):
        return None
    try:
        parsed = urlsplit(value)
        if (parsed.scheme != 'file' or parsed.netloc not in ('', 'localhost')
                or parsed.query or parsed.fragment
                or re.search(r'%(?![0-9a-fA-F]{2})', parsed.path)):
            return None
        path = unquote(parsed.path, encoding='utf-8', errors='strict')
    except (UnicodeError, ValueError):
        return None
    if (not path.startswith('/') or path.startswith('//')
            or '\\' in path or any(ord(c) < 32 or ord(c) == 127 for c in path)
            or any(p in ('.', '..') for p in path.split('/'))
            or '//' in path):
        return None
    return path.rstrip('/') or '/'


def _signature(command, output, code):
    if (not isinstance(command, list) or not command
            or any(not isinstance(part, str) or '\x00' in part for part in command)
            or not isinstance(output, str) or type(code) is not int):
        return None
    return tuple(command), output, code


def bind_command_cwds(trace_text, records):
    """Return {CLI event-index string: runtime cwd} for unambiguous matches.

    Only terminal runtime CommandExecution events in the current completed root
    turn qualify. A repeated command/output signature is ambiguous even when its
    directories happen to match. Source and CLI identifiers have different
    namespaces; they must each be unique, rather than being equated.
    """
    phase = _phase(records)
    if phase is None or not isinstance(trace_text, str):
        return {}
    try:
        # Preserve original line indices used by the adapter. Empty/malformed
        # lines cannot shift a cwd binding onto another command.
        events = [json.loads(line) for line in trace_text.splitlines()]
    except (ValueError, TypeError):
        return {}
    if not events or any(not isinstance(e, dict) for e in events):
        return {}
    thread, turn, begin, end = phase
    roots = [e.get('thread_id') for e in events if e.get('type') == 'thread.started']
    if roots != [thread] or any(e.get('type') in ('error', 'turn.failed') for e in events):
        return {}
    completions = [i for i, e in enumerate(events) if e.get('type') == 'turn.completed']
    starts = [i for i, e in enumerate(events) if e.get('type') == 'turn.started']
    if not completions or not starts or starts[-1] >= completions[-1]:
        return {}
    source_by_signature = {}
    source_ids = set()
    for record in records[begin + 1:end]:
        p = _payload(record)
        item = p.get('item')
        if (record.get('type') != 'event_msg' or p.get('type') != 'item_completed'
                or p.get('thread_id') != thread or p.get('turn_id') != turn
                or not isinstance(item, dict) or item.get('type') != 'CommandExecution'):
            continue
        identifier = item.get('id')
        if not isinstance(identifier, str) or not identifier or identifier in source_ids:
            return {}
        source_ids.add(identifier)
        signature = _signature(item.get('command'), item.get('aggregated_output'), item.get('exit_code'))
        code = item.get('exit_code')
        status = 'completed' if code == 0 else 'failed'
        cwd = _cwd(item.get('cwd'))
        if signature is None:
            continue
        source_by_signature.setdefault(signature, []).append(
            cwd if item.get('status') == status else None)
    cli_by_signature = {}
    cli_ids = set()
    for i, event in enumerate(events):
        if i <= starts[-1] or i >= completions[-1]:
            continue
        item = event.get('item')
        if (event.get('type') != 'item.completed' or not isinstance(item, dict)
                or item.get('type') != 'command_execution'):
            continue
        identifier = item.get('id')
        if not isinstance(identifier, str) or not identifier or identifier in cli_ids:
            return {}
        cli_ids.add(identifier)
        if not isinstance(item.get('command'), str):
            continue
        try:
            words = shlex.split(item.get('command'))
        except (TypeError, ValueError):
            continue
        signature = _signature(words, item.get('aggregated_output'), item.get('exit_code'))
        if signature is None:
            continue
        code = item.get('exit_code')
        coherent = item.get('status', 'completed' if code == 0 else 'failed') == ('completed' if code == 0 else 'failed')
        cli_by_signature.setdefault(signature, []).append(str(i) if coherent else None)
    return {indices[0]: source_by_signature[signature][0]
            for signature, indices in cli_by_signature.items()
            if len(indices) == 1 and indices[0] is not None
            and len(source_by_signature.get(signature, [])) == 1
            and source_by_signature[signature][0] is not None}


def source_command_trace(records):
    """Return data-only command evidence from one caller-owned source session.

    Unlike ``bind_command_cwds``, this API permits a child session because its
    caller must establish ownership and lineage. The envelope and command items
    are derived representations of runtime records, not independent CLI events.
    Every actual model tool call is conservatively unmodeled: a nearby runtime
    command does not prove arbitrary orchestration source had no other reads.
    Callers must review these entries before claiming whole-turn absence.
    """
    result = {'trace_text': '', 'command_cwds': {}, 'unmodeledTools': [],
              'completed': False}
    phase = _phase(records, allow_child=True)
    if phase is None:
        result['unmodeledTools'].append({
            'reason': 'Current source phase is malformed, unfinished or failed'})
        return result
    thread, turn, begin, end = phase
    # This negative-evidence API represents a newly owned child's whole run,
    # rather than just its latest summary turn. Until all own turns can be
    # reconstructed, multiple/ownerless historical phases require raw review.
    owners = {}
    metadata = _payload(records[0])
    origin = metadata.get('source')
    parent = (origin.get('subagent', {}).get('thread_spawn', {}).get('parent_thread_id')
              if isinstance(origin, dict) and isinstance(origin.get('subagent'), dict)
              and isinstance(origin['subagent'].get('thread_spawn'), dict) else None)
    inherited_owners = {parent} if _identifier(parent) and parent != thread else set()

    def inherited(context):
        return bool(owners.get(context)) and owners[context] <= inherited_owners
    for record in records:
        p = _payload(record)
        if (record.get('type') == 'event_msg' and _identifier(p.get('turn_id'))
                and _identifier(p.get('thread_id'))):
            owners.setdefault(p['turn_id'], set()).add(p['thread_id'])
    historical = {_payload(record).get('turn_id') for record in records[:begin]
                  if record.get('type') == 'turn_context'} - {turn}
    other_own_turn = any(prior != turn and thread in threads
                         for prior, threads in owners.items())
    outside_tool = False
    context = None
    for index, record in enumerate(records):
        p = _payload(record)
        if record.get('type') == 'turn_context':
            context = p.get('turn_id')
        if not begin < index < end and _potential_tool_record(record):
            if record.get('type') == 'event_msg':
                foreign = _identifier(p.get('thread_id')) and p['thread_id'] in inherited_owners
            else:
                foreign = inherited(context)
            if not foreign:
                outside_tool = True
    repeated_context = sum(record.get('type') == 'turn_context'
                           and _payload(record).get('turn_id') == turn for record in records) != 1
    repeated_start = sum(record.get('type') == 'event_msg'
                         and _payload(record).get('type') == 'task_started'
                         and _payload(record).get('turn_id') == turn for record in records) != 1
    if (other_own_turn or outside_tool
            or repeated_context or repeated_start
            or any(not inherited(prior) for prior in historical)):
        result['unmodeledTools'].append({
            'reason': 'Repeated, multiple or ambiguous child source phases require whole-run review'})
        return result
    events = [
        {'type': 'thread.started', 'thread_id': thread,
         'derived_from_runtime_source': True},
        {'type': 'turn.started', 'turn_id': turn,
         'derived_from_runtime_source': True},
    ]
    identifiers = set()
    started_ids = set()
    for index in range(begin + 1, end):
        record = records[index]
        p = _payload(record)
        kind = p.get('type')
        item = p.get('item')
        command_runtime = (record.get('type') == 'event_msg'
                           and kind in ('item_started', 'item_completed')
                           and isinstance(item, dict) and item.get('type') == 'CommandExecution')
        if _potential_tool_record(record) and not command_runtime:
            result['unmodeledTools'].append({
                'sourceRecord': index, 'type': kind or record.get('type'),
                'name': p.get('name'), 'callId': p.get('call_id'),
                'reason': 'Tool, output or unknown record is not proven inert'})
        if (record.get('type') == 'event_msg' and kind == 'item_started'
                and isinstance(item, dict) and item.get('type') == 'CommandExecution'):
            terminal = [later for later in records[index + 1:end]
                        if later.get('type') == 'event_msg'
                        and _payload(later).get('type') == 'item_completed'
                        and _payload(later).get('thread_id') == thread
                        and _payload(later).get('turn_id') == turn
                        and isinstance(_payload(later).get('item'), dict)
                        and _payload(later)['item'].get('type') == 'CommandExecution'
                        and _payload(later)['item'].get('id') == item.get('id')]
            if (p.get('thread_id') != thread or p.get('turn_id') != turn
                    or not isinstance(item.get('id'), str) or not item['id']
                    or item['id'] in started_ids or len(terminal) != 1
                    or _signature(item.get('command'), '', 0) is None
                    or item.get('command') != _payload(terminal[0])['item'].get('command')
                    or ('cwd' in item and item['cwd'] != _payload(terminal[0])['item'].get('cwd'))):
                result['unmodeledTools'].append({
                    'sourceRecord': index, 'runtimeItemId': item.get('id'),
                    'reason': 'Unfinished or ambiguous current command start'})
            if isinstance(item.get('id'), str):
                started_ids.add(item['id'])
        if (record.get('type') != 'event_msg' or kind != 'item_completed'
                or not isinstance(item, dict) or item.get('type') != 'CommandExecution'):
            continue
        reason = None
        identifier = item.get('id')
        signature = _signature(item.get('command'), item.get('aggregated_output'),
                               item.get('exit_code'))
        code = item.get('exit_code')
        expected_status = 'completed' if code == 0 else 'failed'
        if p.get('thread_id') != thread or p.get('turn_id') != turn:
            reason = 'Command telemetry does not identify the current thread and turn'
        elif not isinstance(identifier, str) or not identifier or identifier in identifiers:
            reason = 'Missing or duplicate current runtime command ID'
        elif signature is None or item.get('status') != expected_status:
            reason = 'Malformed or nonterminal current command telemetry'
        if reason:
            result['unmodeledTools'].append({
                'sourceRecord': index, 'runtimeItemId': identifier, 'reason': reason})
            continue
        identifiers.add(identifier)
        event_index = len(events)
        derived = {
            'type': 'command_execution', 'id': f'source:{index}:{identifier}',
            'command': shlex.join(item['command']),
            'aggregated_output': item['aggregated_output'], 'exit_code': code,
            'status': expected_status, 'runtime_source_record': index,
            'runtime_item_id': identifier, 'derived_from_runtime_source': True,
        }
        for flag in ('truncated', 'output_truncated'):
            if flag in item:
                derived[flag] = item[flag]
        events.append({'type': 'item.completed', 'item': derived,
                       'derived_from_runtime_source': True})
        cwd = _cwd(item.get('cwd'))
        if cwd is None:
            result['unmodeledTools'].append({
                'sourceRecord': index, 'runtimeItemId': identifier,
                'reason': 'No valid runtime cwd; relative read attribution is unknown'})
        else:
            result['command_cwds'][str(event_index)] = cwd
    events.append({'type': 'turn.completed', 'turn_id': turn,
                   'derived_from_runtime_source': True})
    result['trace_text'] = '\n'.join(json.dumps(event) for event in events)
    result['completed'] = True
    return result

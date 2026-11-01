#!/usr/bin/env python3
"""Attribute a bounded subset of ordinary shell reads without replaying code.

The maintained activation scorer stays unchanged. This adapter accepts only a
successful synchronous literal && list whose entire output is reconstructed
from supplied immutable snapshots and literal separators. Its subordinate
observations are deductions from that one execution, not independent runtime
events. Unsupported source events are retained verbatim for the strict scorer.

``files`` maps known absolute (or cwd-relative) fixture paths to UTF-8 strings.
``cwd`` is an evidence precondition supplied by the caller, not inferred from
the command text. Do not supply it for events whose execution cwd is unknown.
"""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import posixpath
import re
import shlex
import sys


class Unsupported(ValueError):
    pass


def _sha(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _utility(word, names):
    name = word.rsplit('/', 1)[-1]
    return name if name in names and word in (name, '/bin/' + name, '/usr/bin/' + name) else None


def _tokens(source, home=None):
    """Lex literal shell words and && only, retaining shell quote semantics."""
    if not isinstance(source, str) or not source or '\x00' in source:
        raise Unsupported('Missing literal source')
    groups, words, word, active, index = [], [], [], False, 0

    def flush():
        nonlocal active, word
        if active:
            words.append(''.join(word))
            word, active = [], False

    while index < len(source):
        char = source[index]
        if char in ' \t':
            flush()
            index += 1
            continue
        if char == '\n' and ((not active and not words) or not source[index:].strip()):
            # A newline after && continues that list; a terminal newline merely
            # terminates it. Interior command-separating newlines stay unknown.
            flush()
            index += 1
            continue
        if source.startswith('&&', index):
            flush()
            if not words:
                raise Unsupported('Empty && component')
            groups.append(words)
            words = []
            index += 2
            continue
        if char in '\r\n;|&<>(){}$`*?[!#':
            raise Unsupported('Nonliteral shell syntax')
        if char == '~' and not active:
            if (not source.startswith('~/', index) or not isinstance(home, str)
                    or not home.startswith('/') or '..' in home.split('/')):
                raise Unsupported('Home expansion without trusted launch HOME')
            word.append(home.rstrip('/'))
            active = True
            index += 1
            continue
        active = True
        if char == "'":
            end = source.find("'", index + 1)
            if end < 0:
                raise Unsupported('Unclosed quote')
            word.append(source[index + 1:end])
            index = end + 1
        elif char == '"':
            index += 1
            while index < len(source) and source[index] != '"':
                char = source[index]
                if char in '$`':
                    raise Unsupported('Quoted expansion')
                if char == '\\':
                    index += 1
                    if index == len(source) or source[index] not in '\\"$`':
                        raise Unsupported('Unsupported quoted escape')
                    char = source[index]
                word.append(char)
                index += 1
            if index == len(source):
                raise Unsupported('Unclosed quote')
            index += 1
        elif char == '\\':
            index += 1
            if index == len(source) or source[index] in '\r\n':
                raise Unsupported('Incomplete escape')
            word.append(source[index])
            index += 1
        else:
            word.append(char)
            index += 1
    flush()
    if not words:
        raise Unsupported('Empty final component')
    groups.append(words)
    return groups


def _commands(source, depth=0, home=None):
    if depth > 2:
        raise Unsupported('Nested shell bound')
    groups = _tokens(source, home)
    if len(groups) == 1 and len(groups[0]) == 3:
        words = groups[0]
        if _utility(words[0], {'sh', 'bash', 'zsh'}) and words[1] in ('-c', '-lc'):
            return _commands(words[2], depth + 1, home)
    return groups


def _path(value, cwd):
    if not isinstance(value, str) or not value or '\x00' in value or '..' in value.split('/'):
        raise Unsupported('Unresolved path')
    if not value.startswith('/'):
        if not isinstance(cwd, str) or not cwd.startswith('/') or '..' in cwd.split('/'):
            raise Unsupported('Relative path without proven cwd')
        value = posixpath.join(cwd, value)
    return posixpath.normpath(value)


def _snapshots(targets, files, cwd):
    snapshots = {}

    def add(path, content):
        if not isinstance(content, str) or '\x00' in content:
            raise ValueError('Snapshots must be UTF-8 text')
        content.encode('utf-8')
        name = _path(path, cwd)
        if name in snapshots and snapshots[name] != content:
            raise ValueError('Conflicting immutable snapshots')
        snapshots[name] = content

    for target in targets.values():
        for path in [target['path'], *target.get('aliases', [])]:
            add(path, target['content'])
    for path, content in (files or {}).items():
        add(path, content)
    return snapshots


def _printf(words):
    args = words[1:]
    if args and args[0] == '--':
        args = args[1:]
    if not args or args[0].startswith('-'):
        raise Unsupported('Unsupported printf options')
    fmt, data, output, index = args[0], iter(args[1:]), [], 0
    while index < len(fmt):
        char = fmt[index]
        index += 1
        if char == '\\':
            if index == len(fmt) or fmt[index] not in 'nrt\\':
                raise Unsupported('Unsupported printf escape')
            output.append({'n': '\n', 'r': '\r', 't': '\t', '\\': '\\'}[fmt[index]])
            index += 1
        elif char == '%':
            if index == len(fmt) or fmt[index] not in 's%':
                raise Unsupported('Unsupported printf conversion')
            if fmt[index] == '%':
                output.append('%')
            else:
                try:
                    output.append(next(data))
                except StopIteration as error:
                    raise Unsupported('Missing printf data') from error
            index += 1
        else:
            output.append(char)
    try:
        next(data)
        raise Unsupported('Repeated printf format')
    except StopIteration:
        return ''.join(output)


def _component(words, snapshots, cwd):
    name = _utility(words[0], {'cat', 'sed', 'pwd', 'printf'})
    if name == 'cat':
        operands = words[1:]
        if operands and operands[0] == '--':
            operands = operands[1:]
        elif any(path.startswith('-') for path in operands):
            raise Unsupported('Cat options or stdin')
        if not operands or any(path == '-' for path in operands):
            raise Unsupported('Cat stdin')
        result = []
        for operand_index, operand in enumerate(operands):
            path = _path(operand, cwd)
            if path not in snapshots:
                raise Unsupported('Reader outside supplied snapshots')
            result.append((['cat', path], snapshots[path], path, operand_index))
        return result
    if name == 'sed' and len(words) == 4 and words[1] == '-n':
        match = re.fullmatch(r'([1-9]\d*)(?:,([1-9]\d*))?p', words[2])
        if not match or words[3].startswith('-'):
            raise Unsupported('Unsupported sed program')
        start, stop = int(match[1]), int(match[2] or match[1])
        path = _path(words[3], cwd)
        if path not in snapshots or stop < start:
            raise Unsupported('Unsupported sed input')
        content = snapshots[path]
        if any(char in content for char in '\r\v\f\x1c\x1d\x1e\x85\u2028\u2029'):
            raise Unsupported('Non-newline sed line boundaries')
        lines = content.splitlines(keepends=True)
        output = ''.join(lines[start - 1:stop])
        return [(['sed', '-n', f'{start},{stop}p', path], output, path, 0)]
    if name == 'pwd' and len(words) == 1 and cwd is not None:
        path = _path(cwd, None)
        return [(['printf', '%s\n', path], path + '\n', None, None)]
    if name == 'printf':
        return [(words, _printf(words), None, None)]
    raise Unsupported('Unsupported executable or utility contract')


def adapt_ordinary_trace(trace_text, targets, files=None, cwd=None, command_cwds=None, home=None):
    """Return (adapted JSONL, provenance), leaving unsupported events intact."""
    if not isinstance(trace_text, str) or not isinstance(targets, dict):
        raise ValueError('Expected trace text and target mapping')
    snapshots = _snapshots(targets, files, cwd)
    lines = trace_text.splitlines()
    events = []
    for line in lines:
        try:
            events.append(json.loads(line))
        except (ValueError, RecursionError):
            events.append(None)
    identities = Counter(
        event['item']['id'] for event in events
        if isinstance(event, dict) and event.get('type') == 'item.completed'
        and isinstance(event.get('item'), dict) and isinstance(event['item'].get('id'), str)
    )
    output, attributions = [], []
    for event_index, (line, event) in enumerate(zip(lines, events)):
        item = event.get('item') if isinstance(event, dict) else None
        if (not isinstance(item, dict) or event.get('type') != 'item.completed'
                or item.get('type') != 'command_execution' or type(item.get('exit_code')) is not int
                or item['exit_code'] != 0 or not isinstance(item.get('aggregated_output'), str)
                or item.get('truncated') or item.get('output_truncated')
                or ('id' in item and (not isinstance(item['id'], str) or not item['id']
                                     or identities[item['id']] != 1))):
            output.append(line)
            continue
        try:
            command_cwd = (command_cwds or {}).get(str(event_index), cwd)
            commands = _commands(item.get('command'), home=home)
            observations = []
            for component_index, words in enumerate(commands):
                for command, content, path, operand in _component(words, snapshots, command_cwd):
                    observations.append((component_index, operand, command, content, path))
            expected = ''.join(row[3] for row in observations)
            if expected != item['aggregated_output']:
                raise Unsupported('Whole output did not match supplied snapshots')
            if not any(row[4] is not None for row in observations):
                raise Unsupported('No literal file read')
            new_ids = [f'ordinary:{event_index}:{index}' for index in range(len(observations))]
            if any(identity in identities for identity in new_ids):
                raise Unsupported('Derived event identity collision')
        except (Unsupported, TypeError, UnicodeError):
            output.append(line)
            continue
        output_offset = 0
        for ordinal, (component, operand, command, content, path) in enumerate(observations):
            output.append(json.dumps({'type': 'item.completed', 'item': {
                'type': 'command_execution', 'id': new_ids[ordinal],
                'command': shlex.join(command), 'exit_code': 0,
                'aggregated_output': content,
                'ordinary_source_event': event_index,
                'ordinary_source_component': component,
            }}))
            if path is not None:
                attributions.append({
                    'sourceEvent': event_index, 'sourceItemId': item.get('id'),
                    'derivedEvent': len(output) - 1, 'derivedItemId': new_ids[ordinal],
                    'component': component, 'operand': operand, 'path': path,
                    'command': shlex.join(command), 'outputSha256': _sha(content),
                    'outerOutputStart': output_offset, 'outerOutputEnd': output_offset + len(content),
                    'outerCommandSha256': _sha(item['command']),
                    'outerOutputSha256': _sha(item['aggregated_output']),
                    'outerExitCode': 0,
                    'statusEvidence': 'component success is a deduction from one successful synchronous literal command or all-&& list with exact combined output',
                    'executionCwd': command_cwd,
                    'trustedLaunchHome': home,
                })
            output_offset += len(content)
    return '\n'.join(output), attributions


def score_ordinary_trace(trace_text, targets, required, forbidden=(), before=(), files=None, cwd=None, command_cwds=None, home=None):
    """Score original evidence and separately labeled ordinary-read deductions."""
    from activation_trace import score_trace
    strict = score_trace(trace_text, targets, required, forbidden, before)
    adapted, attributions = adapt_ordinary_trace(trace_text, targets, files, cwd, command_cwds, home)
    result = score_trace(adapted, targets, required, forbidden, before)
    boundaries, failures = _start_order(trace_text, adapted, targets, result, before,
                                       set(required) | set(forbidden), score_trace)
    result['failures'] = list(dict.fromkeys([*result['failures'], *failures]))
    result['passed'] = not result['failures']
    return {'strictResult': strict, 'result': result, 'attributions': attributions,
            'orderBoundaries': boundaries}


def _start_order(original, adapted, targets, result, before, known, scorer):
    """Completion order alone cannot establish that two reads did not overlap."""
    known = known | {name for pair in before for name in pair}
    if not known:
        return [], []
    try:
        source = [json.loads(line) for line in original.splitlines()]
        derived = [json.loads(line) for line in adapted.splitlines()]
    except ValueError:
        return [], ['Read start order not established: malformed trace']
    if any(not isinstance(e, dict) or ('item' in e and not isinstance(e['item'], dict))
           for e in [*source, *derived]):
        return [], ['Read start order not established: malformed event']

    def origin(index):
        event = derived[index]
        item = event.get('item', {})
        value = item.get('ordinary_source_event')
        if type(value) is int:
            return value
        matches = [i for i, event in enumerate(source)
                   if event.get('type') == 'item.completed'
                   and ((item.get('id') and event.get('item', {}).get('id') == item['id'])
                        or (not item.get('id') and event == derived[index]))]
        return matches[0] if len(matches) == 1 else None

    def possible(event, target):
        trial = dict(event)
        trial['type'] = 'item.completed'
        # Started events have no terminal status/output; treating the read as
        # possibly successful is conservative for absence and opening order.
        if event.get('type') == 'item.started':
            trial['item'] = {**event['item'], 'exit_code': 0, 'aggregated_output': ''}
            if event['item'].get('type') == 'mcp_tool_call':
                item = event['item']
                arguments = item.get('arguments', {})
                if (item.get('server') in ('functions', 'exec', 'shell', 'codex')
                        and item.get('tool') == 'exec_command' and isinstance(arguments, dict)
                        and isinstance(arguments.get('cmd'), str)):
                    trial['item'] = {'type': 'command_execution',
                                     'command': arguments['cmd'], 'exit_code': 0,
                                     'aggregated_output': ''}
                else:
                    return True
        return not scorer(json.dumps(trial) + '\n' + json.dumps({'type': 'turn.completed'}),
                          targets, [], [target])['passed']

    failures, boundaries = [], []
    def consistent(start, terminal):
        a, b = start['item'], terminal['item']
        fields = ('command',) if a['type'] == 'command_execution' else ('server', 'tool', 'arguments')
        return all(field in a and field in b and a[field] == b[field] for field in fields)

    for start_index, event in enumerate(source):
        item = event.get('item', {})
        if (event.get('type') != 'item.started'
                or item.get('type') not in ('command_execution', 'mcp_tool_call')):
            continue
        identity = item.get('id')
        starts = [candidate for candidate in source if candidate.get('type') == 'item.started'
                  and identity and candidate.get('item', {}).get('id') == identity]
        terminals = [(i, candidate) for i, candidate in enumerate(source) if candidate.get('type') == 'item.completed'
                     and identity and candidate.get('item', {}).get('id') == identity
                     and candidate.get('item', {}).get('type') == item['type']]
        invalid = (len(starts) != 1 or len(terminals) != 1
                   or terminals[0][0] <= start_index
                   or not consistent(event, terminals[0][1]))
        if invalid and any(possible(candidate, name)
                           for candidate in [event, *(terminal for _, terminal in terminals)]
                           for name in known):
            failures.append('Unfinished, contradictory or ambiguous relevant read attempt: ' + str(identity))
    for earlier, later in before:
        covered, complete = [], None
        for read in sorted(result['reads'], key=lambda read: read['event']):
            if read['target'] != earlier:
                continue
            covered.append((read['start'], read['end']))
            end = 0
            for start, stop in sorted(covered):
                if start > end:
                    break
                end = max(end, stop)
            if end == len(targets[earlier]['content']):
                complete = origin(read['event'])
                break
        if complete is None:
            failures.append(f'Read start order not established: {earlier} before {later}')
            continue
        checked = set()
        for index, event in enumerate(source):
            item = event.get('item', {})
            if (event.get('type') not in ('item.started', 'item.completed')
                    or item.get('type') not in ('command_execution', 'mcp_tool_call')
                    or not possible(event, later)):
                continue
            identity = item.get('id')
            matches = [i for i, candidate in enumerate(source)
                       if candidate.get('type') == 'item.completed' and identity
                       and candidate.get('item', {}).get('id') == identity]
            completion = matches[0] if len(matches) == 1 else (index if event['type'] == 'item.completed' else None)
            if (event['type'] == 'item.started' and completion is not None
                    and not possible(source[completion], later)):
                continue
            starts = [i for i, candidate in enumerate(source)
                      if candidate.get('type') == 'item.started' and identity
                      and candidate.get('item', {}).get('id') == identity]
            start = starts[0] if len(starts) == 1 else None
            if (identity, completion) in checked:
                continue
            checked.add((identity, completion))
            # Within one fully reconstructed command the scorer already checks
            # exact component/operand order. Its outer start precedes both reads.
            same = completion == complete and any(
                r['target'] == later and origin(r['event']) == complete
                for r in result['reads'])
            valid = same or (start is not None and start > complete
                             and completion is not None and completion > start)
            boundaries.append({'earlier': earlier, 'later': later,
                               'earlierCompleteSourceEvent': complete,
                               'laterStartSourceEvent': start,
                               'laterCompleteSourceEvent': completion,
                               'withinReconstructedCommand': same, 'passed': valid})
            if not valid:
                failures.append(f'Read start order not established: {earlier} before {later}')
    return boundaries, failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-root', type=Path, default=Path.home() / '.local/share/codex-skills/repository')
    parser.add_argument('--input-file', type=Path, help='Read request JSON from this file instead of stdin')
    parser.add_argument('--adapt-only', action='store_true', help='Inspect deductions without requiring the external scorer')
    args = parser.parse_args()
    request = json.loads(args.input_file.read_text()) if args.input_file else json.load(sys.stdin)
    descendants = request.pop('descendant_sources', [])
    parent_source = request.pop('source_records', None)
    if parent_source is not None:
        from source_evidence import bind_command_cwds
        request['command_cwds'] = bind_command_cwds(request['trace_text'], parent_source)
    if args.adapt_only:
        adapted, attributions = adapt_ordinary_trace(request['trace_text'], request['targets'], request.get('files'), request.get('cwd'), request.get('command_cwds'), request.get('home'))
        result = {'trace': adapted, 'attributions': attributions}
    else:
        sys.path.insert(0, str(args.engine_root.resolve() / 'scripts'))
        result = score_ordinary_trace(**request)
        result = score_descendants(result, request, parent_source, descendants)
    json.dump(result, sys.stdout)
    sys.stdout.write('\n')


def score_descendants(result, request, parent_source, descendants):
    """Keep whole-run absence separate from root-only positive read evidence."""
    from full_skill_run import source_input
    exposures = [name for name in request.get('forbidden', [])
                 if any(source_input(records, request['targets'][name]['content'])
                        for records in [parent_source or [], *descendants])]
    for name in exposures:
        result['result']['failures'].append('Forbidden guidance was present in source input: ' + name)
    if exposures:
        result['result']['passed'] = False
    if not descendants:
        return result
    from source_evidence import source_command_trace
    result['descendantEvidence'] = []
    failures = []
    try:
        parent = parent_source[0]['payload']
        roots = {parent['id']}
        pending = list(descendants)
        while pending:
            selected = []
            for records in pending:
                metadata = records[0]['payload']
                ancestor = metadata['source']['subagent']['thread_spawn']['parent_thread_id']
                if (metadata.get('cwd') == parent.get('cwd') and ancestor in roots
                        and isinstance(metadata.get('id'), str) and metadata['id'] not in roots):
                    roots.add(metadata['id'])
                    selected.append(records)
            if not selected:
                raise ValueError('Unlinked or ambiguous descendant source')
            pending = [records for records in pending if records not in selected]
    except (IndexError, KeyError, TypeError, ValueError):
        failures.append('Unlinked or ambiguous descendant source')
    for records in descendants:
        view = source_command_trace(records)
        scored = score_ordinary_trace(view['trace_text'], request['targets'], [],
                                      request.get('forbidden', []), [],
                                      files=request.get('files'), command_cwds=view['command_cwds'],
                                      home=request.get('home'))
        result['descendantEvidence'].append({'runtimeView': view, 'score': scored})
        if not view['completed']:
            failures.append('Descendant source turn is incomplete or invalid')
        if request.get('forbidden') and view['unmodeledTools']:
            failures.append('Unmodeled descendant tool evidence prevents whole-run absence proof')
        failures.extend('Descendant: ' + failure for failure in scored['result']['failures'])
    if request.get('before'):
        failures.append('Cross-agent read ordering is unverified')
    result['result']['failures'] = list(dict.fromkeys([*result['result']['failures'], *failures]))
    result['result']['passed'] = not result['result']['failures']
    result['scope'] = 'parent and owned descendants'
    return result


if __name__ == '__main__':
    main()

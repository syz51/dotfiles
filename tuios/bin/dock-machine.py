#!/usr/bin/env -S uv run --offline --no-project --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Read the focused shell, never the dock command's cwd or inherited pane.

Prompt titles are hints, not authenticated host metadata. A foreground local
ssh process supplies a destination when a remote editor replaces that hint.
No ssh config is evaluated, connections opened, or state retained.
"""
import json
import os
from pathlib import Path
import re
import shlex
import socket
import subprocess


HOST = r"[A-Za-z0-9][A-Za-z0-9_.-]*"
PROMPT = re.compile(rf"[A-Za-z0-9_.-]+@({HOST}):(?:~|/)[^\x00-\x1f\x7f]*")
MAX_LABEL = 24


def host(value):
    """Only printable ASCII host identifiers can reach the terminal."""
    if not isinstance(value, str) or len(value) > 253:
        return None
    return value if re.fullmatch(HOST, value) else None


def short(value):
    # Keep IPv4 addresses intact; shorten DNS names and .local hostnames.
    value = value if re.fullmatch(r"\d+(?:\.\d+){3}", value) else value.split('.')[0]
    return value


def label(value, remote=False):
    value = short(value)
    prefix = 'ssh ' if remote else ''
    room = MAX_LABEL - len(prefix)
    return prefix + (value if len(value) <= room else value[:room - 1] + '…')


def target(env):
    """Use the dock's exact socket, including named servers and XDG runtimes."""
    if not env.get('TUIOS_SESSION') or not env.get('TUIOS_SOCKET'):
        raise ValueError('missing dock target')
    path = Path(env['TUIOS_SOCKET'])
    if not path.is_absolute() or path.name != 'tuios.sock' or '..' in path.parts:
        raise ValueError('unsupported socket')
    return str(path), env['TUIOS_SESSION']


def focused_window(env):
    """TUIOS's line-delimited JSON read verb; never start or select a daemon.

    TUIOS_SOCKET reports the target but the CLI selects via XDG_RUNTIME_DIR
    and TUIOS_SERVER. Dial it directly to avoid inherited-environment mistakes
    and the legacy /tmp versus /run/user ambiguity, especially named servers.
    """
    path, session = target(env)
    request = {'id': 1, 'verb': 'get-window', 'params': {'session': session}}
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(0.3)
        connection.connect(path)
        connection.sendall(json.dumps(request).encode() + b'\n')
        with connection.makefile('rb') as stream:
            line = stream.readline(65537)
    if len(line) > 65536 or not line.endswith(b'\n'):
        raise ValueError('incomplete response')
    reply = json.loads(line)
    if not isinstance(reply, dict) or reply.get('id') != 1 or reply.get('error'):
        raise ValueError('read failed')
    window = reply.get('result')
    if not isinstance(window, dict):
        raise ValueError('missing window')
    return dict(window, success=True)


def run(args, env=None):
    return subprocess.run(args, env=env, check=True, capture_output=True,
                          text=True, timeout=0.3).stdout


def processes(text):
    rows = {}
    for line in text.splitlines():
        fields = line.split(None, 5)
        if len(fields) != 6:
            continue
        try:
            pid, ppid, pgid, foreground = map(int, fields[:4])
        except ValueError:
            continue
        rows[pid] = (ppid, pgid, foreground, fields[4], fields[5])
    return rows


def active_ssh(rows, shell):
    """Find ssh only in the shell's foreground job, excluding background tunnels."""
    root = rows.get(shell)
    if root is None or root[2] <= 0 or root[3] in ('?', '??'):
        return None
    descendants = {shell}
    # Each pass follows parents, so nested wrappers are supported without
    # assuming table order. Bound the depth for corrupt/cyclic snapshots.
    for _ in range(32):
        added = {pid for pid, row in rows.items() if row[0] in descendants}
        if added <= descendants:
            break
        descendants |= added
    candidates = [pid for pid in descendants if rows[pid][1] == root[2]
                  and rows[pid][3] == root[3]
                  and Path(rows[pid][4]).name == 'ssh']
    # Multiple ssh clients in a foreground pipeline are ambiguous.
    return candidates[0] if len(candidates) == 1 else (0 if candidates else None)


def destination(command):
    """Parse only known OpenSSH options; never execute -G/Match exec or a proxy."""
    try:
        args = shlex.split(command)
    except ValueError:
        return None
    if not args or Path(args.pop(0)).name != 'ssh':
        return None
    takes_value = 'BbcDEeFIiJLlmOoPpQRSWw'
    flags = '46AaCfGgKkMNnqsTtVvXxYy'
    while args:
        arg = args.pop(0)
        if arg == '--':
            break
        if not arg.startswith('-'):
            args.insert(0, arg)
            break
        options = arg[1:]
        if not options:
            return None
        for i, option in enumerate(options):
            if option in takes_value:
                if i == len(options) - 1:
                    if not args:
                        return None
                    args.pop(0)
                break
            if option not in flags:
                return None
    # ps is a display string, not an argv array: spaces in option values lose
    # their boundaries. Extra words could be a remote command or a split
    # ProxyCommand/key path, so do not guess which word is the destination.
    if len(args) != 1:
        return None
    value = args[0]
    # URI/IPv6 and unusual option forms deliberately fall back to ssh ?.
    return host(value.rsplit('@', 1)[-1])


def machine(window, rows, local, ssh_command):
    if not isinstance(window, dict) or window.get('success') is not True or window.get('focused') is not True:
        return 'host ?'
    shell = window.get('shell_pgid')
    if (not isinstance(shell, int) or shell not in rows or rows[shell][2] <= 0
            or rows[shell][3] in ('?', '??')):
        return 'host ?'
    title = window.get('title', '')
    match = PROMPT.fullmatch(title) if isinstance(title, str) and len(title) <= 4096 else None
    reported = host(match[1]) if match else None
    ssh = active_ssh(rows, shell)
    local = host(local)
    is_local = lambda name: local and short(name).lower() == short(local).lower()
    if ssh is not None:
        # At SSH entry the title may still be the local prompt. At exit no
        # remote title is trusted once the ssh foreground job has gone away.
        if reported and not is_local(reported):
            return label(reported, True)
        dest = destination(ssh_command(ssh)) if ssh else None
        return label(dest, True) if dest else 'ssh ?'
    if reported:
        return label(reported) if is_local(reported) else 'host ?'
    return label(local) if local else 'host ?'


def main():
    try:
        window = focused_window(os.environ)
        rows = processes(run(['/bin/ps', '-wwaxo', 'pid=,ppid=,pgid=,tpgid=,tty=,comm=']))
        result = machine(window, rows, socket.gethostname(),
                         lambda pid: run(['/bin/ps', '-ww', '-p', str(pid), '-o', 'command=']))
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        result = 'host ?'
    print(result)


if __name__ == '__main__':
    main()

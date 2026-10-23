#!/usr/bin/env -S uv run --offline --no-project --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Manually query cell device pixels in an idle, direct Ghostty shell."""
import argparse
import copy
import json
import os
import select
import signal
import termios
import time


RESPONSE_TIMEOUT = 2.0


class ProbeError(Exception):
    pass


def check_environment(env):
    if env.get('TERM_PROGRAM') != 'ghostty':
        raise ProbeError('Run in a normal Ghostty shell (TERM_PROGRAM must be ghostty).')
    if any(key == 'TUIOS' or key.startswith('TUIOS_') for key in env):
        raise ProbeError('Run outside TUIOS; TUIOS environment variables are present.')
    if ('TMUX' in env or 'STY' in env
            or env.get('TERM', '').startswith(('screen', 'tmux'))):
        raise ProbeError('Run directly in Ghostty, outside terminal multiplexers.')


def read_response(fd):
    """Read only the bounded reply, one byte at a time; never print input."""
    deadline = time.monotonic() + RESPONSE_TIMEOUT

    def byte():
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise ProbeError('Timed out waiting for the cell-pixel response (2 seconds).')
        value = os.read(fd, 1)
        if not value:
            raise ProbeError('Terminal closed before the cell-pixel response completed.')
        return value

    for expected in b'\x1b[6;':
        if byte() != bytes([expected]):
            raise ProbeError('Malformed response; expected ESC[6;height;widtht.')

    def dimension(delimiter):
        digits = bytearray()
        while True:
            value = byte()
            if value == delimiter and digits:
                result = int(digits)
                if result > 0:
                    return result
                break
            if not b'0' <= value <= b'9' or len(digits) == 6:
                break
            digits.extend(value)
        raise ProbeError('Malformed response; expected positive cell dimensions in ESC[6;height;widtht.')

    height = dimension(b';')
    width = dimension(b't')
    return width, height


def measure():
    check_environment(os.environ)
    fd = os.open('/dev/tty', os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    original = None
    handlers = {}

    def interrupted(signum, _frame):
        raise ProbeError(f'Interrupted by {signal.Signals(signum).name}; measurement aborted.')

    try:
        original = termios.tcgetattr(fd)
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP,
                       signal.SIGQUIT, signal.SIGTSTP):
            handlers[signum] = signal.signal(signum, interrupted)
        mode = copy.deepcopy(original)
        mode[3] &= ~(termios.ECHO | termios.ICANON)
        mode[6][termios.VMIN] = 0
        mode[6][termios.VTIME] = 0
        # TCSANOW deliberately avoids flushing queued user input.
        termios.tcsetattr(fd, termios.TCSANOW, mode)
        if select.select([fd], [], [], 0)[0]:
            raise ProbeError('Terminal input is pending; retry when the shell is idle.')
        if os.write(fd, b'\x1b[16t') != 5:
            raise ProbeError('Could not send the complete cell-pixel query.')
        return read_response(fd)
    finally:
        try:
            # Prevent another handled signal from interrupting restoration.
            for signum in handlers:
                signal.signal(signum, signal.SIG_IGN)
            if original is not None:
                termios.tcsetattr(fd, termios.TCSANOW, original)
        finally:
            os.close(fd)
            for signum, handler in handlers.items():
                signal.signal(signum, handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog=(
        'Run manually in a normal Ghostty shell OUTSIDE TUIOS, tmux, or screen, '
        'while the shell is idle. Do not type during the query: terminal replies '
        'and keystrokes share the same input stream. Opens /dev/tty, temporarily '
        'disables echo and canonical input, sends CSI 16 t, and waits at most '
        '2 seconds for ESC[6;height;widtht. Reads only the bounded query reply; '
        'does not flush input or log raw input. Restores terminal settings on '
        'success, errors, and handled interruption signals (uncatchable SIGKILL '
        'and SIGSTOP cannot be handled). Reports JSON to stdout. Measures ONLY '
        'actual cell device pixels, not font family, baseline, or visual '
        'correctness; this cannot justify installation. No drawing, images, '
        'configuration changes, or daemon edits. Environment checks cannot '
        'authenticate the terminal; do not override them to run in a wrapper.'
    ))
    parser.parse_args()
    try:
        width, height = measure()
    except (ProbeError, OSError, termios.error) as error:
        # OS diagnostics are safe; never include terminal response bytes.
        print(json.dumps({'status': 'error', 'error': str(error)}))
        return 1
    print(json.dumps({
        'status': 'ok',
        'query': 'CSI 16 t',
        'cell_width_px': width,
        'cell_height_px': height,
        'scope': 'actual cell device pixels only',
    }))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

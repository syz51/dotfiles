"""Synthetic PTYs only: never contact an actual Ghostty or TUIOS session."""
import copy
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import sys
import termios
import time
import unittest


PROBE = Path(__file__).resolve().parents[1] / 'bin/probe-ghostty-metrics.py'
# Keep the synthetic session leader alive until the parent checks termios:
# macOS revokes the slave terminal when its session leader exits.
HARNESS = '''
import os, runpy, sys
path, done, release = sys.argv[1:]
sys.argv = [path]
namespace = runpy.run_path(path)
result = namespace['main']()
os.write(int(done), b'done')
os.read(int(release), 1)
raise SystemExit(result)
'''


def direct_environment():
    env = {key: value for key, value in os.environ.items()
           if not key.startswith('TUIOS_') and key not in ('TUIOS', 'TMUX', 'STY')}
    env.update(TERM_PROGRAM='ghostty', TERM='xterm-256color')
    return env


class ProbeTests(unittest.TestCase):
    def start_probe(self, env=None, pending=None):
        master, slave = pty.openpty()
        self.addCleanup(os.close, master)
        self.addCleanup(os.close, slave)
        original = termios.tcgetattr(slave)
        done_read, done_write = os.pipe()
        release_read, release_write = os.pipe()
        self.addCleanup(os.close, done_read)
        self.addCleanup(os.close, release_write)
        if pending is not None:
            os.write(master, pending)
            # Drain only the PTY's echo output, leaving its input untouched.
            self.assertTrue(select.select([master], [], [], 1)[0])
            os.read(master, 100)

        def controlling_terminal():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        process = subprocess.Popen(
            [sys.executable, '-B', '-c', HARNESS, str(PROBE),
             str(done_write), str(release_read)], stdin=slave,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=direct_environment() if env is None else env,
            preexec_fn=controlling_terminal,
            pass_fds=(done_write, release_read),
        )
        os.close(done_write)
        os.close(release_read)
        process.probe_done = done_read
        process.probe_release = release_write

        def stop():
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)

        self.addCleanup(stop)
        return process, master, slave, original

    def await_query(self, master):
        received = b''
        deadline = time.monotonic() + 5
        while len(received) < 5:
            remaining = deadline - time.monotonic()
            self.assertGreater(remaining, 0, 'probe did not send its query')
            self.assertTrue(select.select([master], [], [], remaining)[0])
            chunk = os.read(master, 5 - len(received))
            self.assertTrue(chunk, 'PTY closed before query')
            received += chunk
        self.assertEqual(received, b'\x1b[16t')

    def finish(self, process, slave, original, success=False, pending=None, quiet=None):
        self.assertTrue(select.select([process.probe_done], [], [], 5)[0],
                        'probe did not finish within its bounded wait')
        self.assertEqual(os.read(process.probe_done, 4), b'done')
        restored = termios.tcgetattr(slave)
        expected = copy.deepcopy(original)
        # Darwin sets this kernel input-reprocessing flag when ICANON changes.
        # It is not a user setting, and must remain set for queued input.
        for state in (restored, expected):
            state[3] &= ~getattr(termios, 'PENDIN', 0)
        self.assertEqual(restored, expected)
        if quiet is not None:
            self.assertFalse(select.select([quiet], [], [], 0)[0])
        if pending is not None:
            master, expected_input = pending
            self.assertTrue(select.select([slave], [], [], 1)[0])
            self.assertEqual(os.read(slave, 100), expected_input)
            # Recanonicalizing queued input can echo it again on Darwin.
            # Drain synthetic output so session teardown cannot wait on it.
            while select.select([master], [], [], 0)[0]:
                os.read(master, 100)
        os.write(process.probe_release, b'x')
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(stderr, b'')
        self.assertEqual(process.returncode, 0 if success else 1)
        result = json.loads(stdout)
        self.assertEqual(result['status'], 'ok' if success else 'error')
        return result

    def test_success_and_restoration(self):
        process, master, slave, original = self.start_probe()
        self.await_query(master)
        active = termios.tcgetattr(slave)
        self.assertFalse(active[3] & (termios.ECHO | termios.ICANON))
        # Fragmentation exercises the byte-wise parser.
        for fragment in (b'\x1b[', b'6;40;', b'20t'):
            os.write(master, fragment)
        result = self.finish(process, slave, original, success=True)
        self.assertEqual(result['cell_width_px'], 20)
        self.assertEqual(result['cell_height_px'], 40)

    def test_timeout_and_restoration(self):
        process, master, slave, original = self.start_probe()
        self.await_query(master)
        started = time.monotonic()
        result = self.finish(process, slave, original)
        self.assertIn('Timed out', result['error'])
        self.assertLess(time.monotonic() - started, 2.5)

    def test_input_after_reply_is_not_consumed(self):
        process, master, slave, original = self.start_probe()
        self.await_query(master)
        os.write(master, b'\x1b[6;40;20ttyped-after\n')
        self.finish(process, slave, original, success=True,
                    pending=(master, b'typed-after\n'))

    def test_malformed_responses_and_restoration(self):
        for reply in (b'PRIVATE_KEYSTROKE', b'\x1b[4;40;20t', b'\x1b[6;0;20t',
                      b'\x1b[6;;20t', b'\x1b[6;40;-20t', b'\x1b[6;40;20x',
                      b'\x1b[6;1234567;20t'):
            with self.subTest(reply=reply):
                process, master, slave, original = self.start_probe()
                self.await_query(master)
                os.write(master, reply)
                result = self.finish(process, slave, original)
                self.assertIn('Malformed response', result['error'])
                self.assertNotIn('PRIVATE', json.dumps(result))

    def test_signals_restore_terminal(self):
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP,
                       signal.SIGQUIT, signal.SIGTSTP):
            with self.subTest(signal=signum):
                process, master, slave, original = self.start_probe()
                self.await_query(master)
                process.send_signal(signum)
                result = self.finish(process, slave, original)
                self.assertIn(signal.Signals(signum).name, result['error'])

    def test_environment_rejected_before_query(self):
        for updates in ({'TERM_PROGRAM': 'other'}, {'TUIOS_SOCKET': ''},
                        {'TUIOS_SESSION': 'synthetic'}, {'TUIOS_SERVER': ''},
                        {'TUIOS': ''}, {'TMUX': ''}, {'STY': ''},
                        {'TERM': 'screen-256color'}):
            with self.subTest(updates=updates):
                env = direct_environment()
                env.update(updates)
                process, master, slave, original = self.start_probe(env)
                self.finish(process, slave, original, quiet=master)

    def test_pending_input_is_preserved(self):
        process, master, slave, original = self.start_probe(pending=b'idle-input\n')
        result = self.finish(process, slave, original, pending=(master, b'idle-input\n'))
        self.assertIn('input is pending', result['error'])

    def test_no_controlling_terminal_reports_json(self):
        result = subprocess.run(
            [sys.executable, str(PROBE)], stdin=subprocess.DEVNULL,
            capture_output=True, env=direct_environment(), start_new_session=True,
            timeout=5,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, b'')
        self.assertEqual(json.loads(result.stdout)['status'], 'error')

    def test_help_needs_no_terminal(self):
        result = subprocess.run([sys.executable, str(PROBE), '--help'],
                                capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertIn(b'OUTSIDE TUIOS', result.stdout)
        self.assertIn(b'font family', b' '.join(result.stdout.split()))


if __name__ == '__main__':
    unittest.main()

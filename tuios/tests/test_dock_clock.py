"""Exercise the configured push clock without waiting for wall-clock minutes."""
import pathlib
import subprocess
import tomllib
import unittest

CONFIG = pathlib.Path(__file__).resolve().parents[1] / 'config.toml'


class DockClockTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.clock = tomllib.loads(CONFIG.read_text())['dock']['custom']['clock']

    def run_clock(self, setup):
        # Mock only the time source and sleep; execute the actual loop in sh.
        return subprocess.run(
            ['/bin/sh', '-c', setup + '\n' + self.clock['command'].replace('/bin/date', 'date')],
            capture_output=True, text=True, timeout=5,
        )

    def test_every_second_has_portable_minute_delay(self):
        self.assertEqual(self.clock['refresh'], 'push')
        for seconds in range(60):
            with self.subTest(seconds=seconds):
                result = self.run_clock(
                    f"date() {{ printf '12:34 {seconds:02d}\\n'; }}\n"
                    "sleep() { printf 'delay=%s\\n' \"$1\" >&2; return 1; }"
                )
                self.assertEqual(result.returncode, 1)  # mock sleep ends loop
                self.assertEqual(result.stdout, ' 12 : 34 \n')
                self.assertEqual(result.stderr, f'delay={60 - seconds}\n')

    def test_push_updates_again_after_minute_boundary(self):
        result = self.run_clock('''
step=0
date() {
  if [ "$step" = 0 ]; then printf '12:34 08\\n'; else printf '12:35 00\\n'; fi
}
sleep() {
  printf 'delay=%s\\n' "$1" >&2
  step=$((step + 1))
  [ "$step" -lt 2 ]
}
''')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, ' 12 : 34 \n 12 : 35 \n')
        self.assertEqual(result.stderr, 'delay=52\ndelay=60\n')


if __name__ == '__main__':
    unittest.main()

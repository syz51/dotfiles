"""Machine labels from dock routing, prompt hints and foreground process evidence."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tomllib
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('dock_machine', ROOT / 'bin/dock-machine.py')
machine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(machine)


class MachineTests(unittest.TestCase):
    def window(self, title='roy@laptop.local:~/.config', **extra):
        return dict(success=True, focused=True, title=title, shell_pgid=10, **extra)

    def rows(self, ssh=False):
        foreground = 20 if ssh else 10
        rows = {10: (1, 10, foreground, 'ttys001', '/bin/zsh')}
        if ssh:
            rows[20] = (10, 20, 20, 'ttys001', '/usr/bin/ssh')
        return rows

    def render(self, title='roy@laptop.local:~/.config', ssh=False, command='ssh build.example.org'):
        return machine.machine(self.window(title), self.rows(ssh), 'laptop.local', lambda _: command)

    def test_local_prompt_and_opaque_local_app(self):
        self.assertEqual(self.render(), 'laptop')
        for title in ('nvim main.py', 'ssh build', 'user@build', 'docs@remote: notes'):
            self.assertEqual(self.render(title), 'laptop')

    def test_remote_prompt_preferred_to_alias(self):
        self.assertEqual(self.render('roy@actual.example.org:/srv', True), 'ssh actual')

    def test_ssh_enter_editor_and_exit_have_no_cached_host(self):
        self.assertEqual(self.render(ssh=True), 'ssh build')  # local title still present
        self.assertEqual(self.render('nvim project', True), 'ssh build')
        self.assertEqual(self.render('nvim project'), 'laptop')
        self.assertEqual(self.render('roy@build:/srv'), 'host ?')  # stale SSH title
        self.assertEqual(self.render(), 'laptop')

    def test_unknown_destination_never_claims_local(self):
        for command in ('ssh', 'ssh -z secret', 'ssh "unterminated', 'ssh ssh://user@build:22'):
            self.assertEqual(self.render('nvim project', True, command), 'ssh ?')

    def test_destinations_and_options(self):
        for command, expected in (
            ('ssh -p 2222 -i /private/key user@build.example.org', 'build.example.org'),
            ('/usr/bin/ssh -vvtt -J jump -o ProxyCommand=private user@prod', 'prod'),
            ('ssh -p2222 -- user@10.0.0.2', '10.0.0.2'),
            ('ssh -l user -L 9000:private:80 build', 'build'),
        ):
            with self.subTest(command=command):
                self.assertEqual(machine.destination(command), expected)

    def test_ps_argument_boundaries_are_not_guessed(self):
        for command in ('ssh -o ProxyCommand=ssh jump nc %h %p build',
                        'ssh -i /path with spaces/key build', 'ssh build nvim'):
            self.assertIsNone(machine.destination(command))

    def test_background_and_other_pane_ssh_ignored(self):
        rows = self.rows()
        rows[20] = (10, 20, 10, 'ttys001', '/usr/bin/ssh')
        rows[30] = (1, 30, 30, 'ttys002', '/usr/bin/ssh')
        self.assertIsNone(machine.active_ssh(rows, 10))
        self.assertEqual(machine.machine(self.window(), rows, 'laptop', lambda _: self.fail()), 'laptop')

    def test_wrapped_foreground_ssh_and_multiple_clients(self):
        rows = self.rows(True)
        rows[21] = (20, 20, 20, 'ttys001', '/bin/wrapper')
        rows[22] = (21, 20, 20, 'ttys001', '/usr/bin/ssh')
        self.assertEqual(machine.active_ssh(rows, 10), 0)
        self.assertEqual(machine.machine(self.window('nvim'), rows, 'laptop', lambda _: self.fail()), 'ssh ?')
        del rows[20]
        rows[21] = (10, 20, 20, 'ttys001', '/bin/wrapper')
        self.assertEqual(machine.active_ssh(rows, 10), 22)

    def test_focused_pane_and_unavailable_metadata(self):
        window = self.window()
        window['focused'] = False
        self.assertEqual(machine.machine(window, self.rows(), 'laptop', lambda _: ''), 'host ?')
        self.assertEqual(machine.machine(self.window(), {}, 'laptop', lambda _: ''), 'host ?')
        # A newly focused pane is evaluated independently of the previous one.
        second = self.window('roy@other:/srv')
        second['shell_pgid'] = 99
        rows = {99: (1, 99, 100, 'ttys002', '/bin/zsh'),
                100: (99, 100, 100, 'ttys002', '/usr/bin/ssh')}
        self.assertEqual(machine.machine(second, rows, 'laptop', lambda _: 'ssh other'), 'ssh other')

    def test_unsafe_and_overlong_labels(self):
        for value in ('bad\x1b[31m', 'bad\nlabel', 'bad\x9b31m', '-option', 'a/b', '机器'):
            self.assertIsNone(machine.host(value))
            self.assertEqual(self.render('nvim', True, f'ssh "{value}"'), 'ssh ?')
        self.assertEqual(self.render('roy@evil\x1b[31m:/tmp', True), 'ssh build')
        value = self.render('roy@' + 'x' * 80 + ':/tmp', True)
        self.assertEqual(len(value), 24)
        self.assertTrue(value.endswith('…'))
        self.assertEqual(machine.label('10.0.0.2', True), 'ssh 10.0.0.2')

    def test_ps_parser(self):
        self.assertEqual(machine.processes(' 10 1 10 20 ttys001 /bin/zsh\ninvalid\n'),
                         {10: (1, 10, 20, 'ttys001', '/bin/zsh')})

    def test_socket_overrides_inherited_server_and_runtime(self):
        base = dict(TUIOS_SESSION='active session', TUIOS_SERVER='stale', XDG_RUNTIME_DIR='/stale')
        for path in (
            f'/tmp/tuios-{os.getuid()}/tuios.sock',
            f'/tmp/tuios-{os.getuid()}/servers/work/tuios.sock',
            '/run/user/501/tuios/tuios.sock',
            '/run/user/501/tuios/servers/work/tuios.sock',
            '/private/runtime/tuios/servers/test/tuios.sock',
        ):
            with self.subTest(path=path):
                self.assertEqual(machine.target(dict(base, TUIOS_SOCKET=path)), (path, 'active session'))

    def test_missing_or_unsafe_target_fails_closed(self):
        for env in ({}, {'TUIOS_SESSION': 'test'},
                    {'TUIOS_SESSION': 'test', 'TUIOS_SOCKET': '/other/socket'},
                    {'TUIOS_SESSION': 'test', 'TUIOS_SOCKET': '/tmp/tuios/servers/../tuios.sock'}):
            with self.assertRaises(ValueError):
                machine.target(env)

    def test_protocol_targets_exact_socket_and_session(self):
        env = {'TUIOS_SESSION': 'chosen', 'TUIOS_SOCKET': f'/tmp/tuios-{os.getuid()}/tuios.sock'}
        connection = MagicMock()
        connection.makefile.return_value = io.BytesIO(b'{"id":1,"result":{"focused":true,"shell_pgid":10}}\n')
        with patch.object(machine.socket, 'socket') as sock:
            sock.return_value.__enter__.return_value = connection
            result = machine.focused_window(env)
        connection.connect.assert_called_once_with(env['TUIOS_SOCKET'])
        request = json.loads(connection.sendall.call_args.args[0])
        self.assertEqual(request, {'id': 1, 'verb': 'get-window', 'params': {'session': 'chosen'}})
        self.assertTrue(result['success'])

    def test_protocol_rejects_errors_mismatched_ids_and_unbounded_output(self):
        env = {'TUIOS_SESSION': 'test', 'TUIOS_SOCKET': '/tmp/tuios/tuios.sock'}
        for reply in (b'{"id":2,"result":{}}\n', b'{"id":1,"error":{"message":"private"}}\n',
                      b'{"id":1,"result":null}\n', b'{}', b'x' * 65537):
            connection = MagicMock()
            connection.makefile.return_value = io.BytesIO(reply)
            with patch.object(machine.socket, 'socket') as sock:
                sock.return_value.__enter__.return_value = connection
                with self.assertRaises(ValueError):
                    machine.focused_window(env)

    def test_main_sanitizes_failures(self):
        with patch.object(machine, 'focused_window', return_value=self.window()), \
                patch.object(machine, 'run', return_value='10 1 10 10 ttys001 /bin/zsh'), \
                patch.object(machine.socket, 'gethostname', return_value='laptop'), patch('builtins.print') as out:
            machine.main()
            out.assert_called_once_with('laptop')
        with patch.object(machine, 'focused_window', side_effect=ValueError('private')), patch('builtins.print') as out:
            machine.main()
            out.assert_called_once_with('host ?')

    def test_bar_contract(self):
        config = tomllib.loads((ROOT / 'config.toml').read_text())
        dock = config['dock']
        self.assertEqual(dock['left'], ['workspaces', 'custom/machine', 'custom/separator'])
        self.assertEqual(dock['custom']['machine']['refresh'], '1s')
        self.assertEqual(dock['custom']['machine']['bg'], '#303446')
        self.assertEqual(dock['custom']['separator']['command'], "printf '∣'")
        self.assertEqual(config['appearance']['window_title_position'], 'hidden')


if __name__ == '__main__':
    unittest.main()

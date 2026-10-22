"""Integration tests: real zsh command parsing, fd/zoxide rows and Neovim RPC."""
import os
import pty
import pathlib
import re
import select
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
BIN = ROOT / 'bin'
HOSTILE = ['space name', "apost'rophe", 'double"quote', '$dollar', '*glob', '-leading', '日本語', 'percent%hash#pipe|bang!', 'tab\tname']


class ExploreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        parent = os.environ.get('EXPLORE_TEST_TMP')
        cls.scratch = pathlib.Path(tempfile.mkdtemp(prefix='t-', dir=parent)).resolve()
        cls.env = dict(os.environ, _ZO_DATA_DIR=str(cls.scratch / 'zoxide'),
                       XDG_CACHE_HOME=str(cls.scratch/'cache'),
                       XDG_DATA_HOME=str(cls.scratch/'data'),
                       XDG_STATE_HOME=str(cls.scratch/'state'),
                       TMPDIR=str(cls.scratch), NVIM_LOG_FILE='/dev/null')
        (cls.scratch / 'zoxide').mkdir()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.scratch)

    def zsh(self, script, *args, env=None, check=True):
        return subprocess.run(['zsh', '-f', '-c', script, 'test', *map(str, args)], env=env or self.env, capture_output=True, check=check)

    def test_television_selection_preserves_argv_and_status(self):
        base = self.scratch/'tv-selection'; base.mkdir()
        home = base/'home'; home.mkdir()
        fake = base/'bin'; fake.mkdir()
        private = home/'.local/opt/explore-television/tv'
        private.parent.mkdir(parents=True)
        override = base/'override tv'
        for binary, label in [(fake/'tv', 'system'), (private, 'private'), (override, 'override')]:
            binary.write_text(f'#!/bin/zsh -f\nprintf "%s\\0" {label} "$@"\nexit 37\n')
            binary.chmod(0o755)
        env = dict(self.env, HOME=str(home), PATH=str(fake)+':'+self.env['PATH'])
        env.pop('EXPLORE_TELEVISION', None)
        args = ['space name', '$literal', '', '--version']
        for label in ['private', 'override', 'system']:
            with self.subTest(selection=label):
                run_env = dict(env)
                if label == 'override': run_env['EXPLORE_TELEVISION'] = str(override)
                if label == 'system':
                    private.unlink()
                    private.mkdir()  # Searchable directories are not executable binaries.
                result = subprocess.run([str(BIN/'explore-television'), *args], env=run_env, capture_output=True)
                self.assertEqual(result.returncode, 37, result.stderr)
                self.assertEqual(result.stdout.split(b'\0')[:-1], [label.encode(), *[a.encode() for a in args]])

    def test_invalid_television_override_fails_before_session_or_launch(self):
        base = self.scratch/'tv-invalid'; base.mkdir()
        fake = base/'bin'; fake.mkdir()
        marker = base/'unexpected-launch'
        for name in ['tv', 'mktemp']:
            binary = fake/name
            binary.write_text('#!/bin/zsh -f\nprint called >> "$LAUNCH_MARKER"\nexit 99\n')
            binary.chmod(0o755)
        nonexec = base/'non-executable'; nonexec.touch()
        env = dict(self.env, PATH=str(fake)+':'+self.env['PATH'], LAUNCH_MARKER=str(marker))
        for override in [str(base/'missing'), str(base), str(nonexec), 'tv']:
            for command in [('explore-television', '--version'), ('explore-tv', str(base)), ('explore-tv', '--resume')]:
                with self.subTest(override=override, command=command):
                    result = subprocess.run([str(BIN/command[0]), command[1]],
                                            env=dict(env, EXPLORE_TELEVISION=override), capture_output=True)
                    self.assertEqual(result.returncode, 69, result.stderr)
                    self.assertIn(b'EXPLORE_TELEVISION', result.stderr)
                    self.assertEqual(result.stdout, b'')
                    self.assertFalse(marker.exists())

    def test_installer_resolves_relative_physical_build_root_and_cleans_failure(self):
        base = self.scratch/'installer'; base.mkdir()
        build = base/'physical-build'; build.mkdir()
        (base/'build-link').symlink_to(build, target_is_directory=True)
        fake = base/'bin'; fake.mkdir()
        output = base/'download-path'
        for name in ['cargo', 'rustc', 'rustup']:
            binary = fake/name
            binary.write_text('#!/bin/sh\ncase "$1" in --version) echo "stub version";; which) exit 0;; *) exit 99;; esac\n')
            binary.chmod(0o755)
        curl = fake/'curl'
        curl.write_text('#!/bin/zsh -f\nprint -r -- "${@[-1]}" > "$DOWNLOAD_PATH"\nexit 42\n')
        curl.chmod(0o755)
        env = dict(self.env, PATH=str(fake)+':'+self.env['PATH'], DOWNLOAD_PATH=str(output),
                   EXPLORE_TELEVISION_BUILD_ROOT='build-link', EXPLORE_TELEVISION_DEST=str(base/'dest'))
        result = subprocess.run([str(ROOT/'install-television.sh')], cwd=base, env=env, capture_output=True)
        self.assertEqual(result.returncode, 42, result.stderr)
        archive = pathlib.Path(output.read_text().strip())
        self.assertTrue(archive.is_absolute())
        self.assertEqual(archive.parent.parent, build)
        self.assertEqual(archive.name, 'source.tar.gz')
        self.assertEqual(list(build.iterdir()), [])
        self.assertFalse((base/'dest').exists())
        output.unlink()
        for invalid in ['missing', 'download-path-file']:
            if invalid == 'download-path-file': (base/invalid).touch()
            result = subprocess.run([str(ROOT/'install-television.sh')], cwd=base,
                                    env=dict(env, EXPLORE_TELEVISION_BUILD_ROOT=invalid), capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'build root', result.stderr)
            self.assertFalse(output.exists())

    def test_shell_command_quotes_real_argv(self):
        work = self.scratch / 'quoted'
        work.mkdir()
        paths = []
        for name in HOSTILE:
            p = work / name
            p.touch()
            paths.append(p)
        result = self.zsh('source "$1"; cd -- "$2"; shift 2; cmd=$(explore-command open "$@"); nvim() { printf "%s\\0" "$@"; }; eval "$cmd"', ROOT / 'explore.zsh', work, *paths)
        self.assertEqual(result.stdout.split(b'\0')[:-1], [b'--', *[p.name.encode() for p in paths]])
        outside = self.scratch / 'outside'
        outside.touch()
        result = self.zsh('source "$1"; cd -- "$2"; cmd=$(explore-command open "$3"); nvim() { printf "%s\\0" "$@"; }; eval "$cmd"', ROOT / 'explore.zsh', work, outside)
        self.assertEqual(result.stdout.split(b'\0')[:-1], [b'--', bytes(outside)])
        logical=self.scratch/'logical';logical.symlink_to(work,target_is_directory=True)
        result=self.zsh('source "$1"; cd -L -- "$2"; cmd=$(explore-command open "$3"); nvim() { printf "%s\\0" "$@"; }; eval "$cmd"',ROOT/'explore.zsh',logical,paths[0])
        self.assertEqual(result.stdout.split(b'\0')[:-1],[b'--',paths[0].name.encode()])

    def test_directory_commands(self):
        folder = self.scratch / "folder '日本語$*"
        folder.mkdir()
        result = self.zsh('source "$1"; cmd=$(explore-command nvim "$2"); nvim() { printf "%s\\0" "$PWD"; }; eval "$cmd"', ROOT / 'explore.zsh', folder)
        self.assertEqual(result.stdout, bytes(folder.resolve()) + b'\0')
        self.assertNotEqual(self.zsh('source "$1"; explore-command wrong "$2"', ROOT / 'explore.zsh', folder, check=False).returncode, 0)

    def test_rows_order_scope_and_protocol(self):
        work = self.scratch / 'rows'
        work.mkdir()
        (work/'b-dir').mkdir(); (work/'a-dir').mkdir()
        (work/'a-dir/deep').touch(); (work/'.hidden').touch()
        (work/'.ignore').write_text('*.log\n')
        (work/'a-dir/debug.log').touch()
        for name in HOSTILE: (work/name).touch()
        for name in ['.git','Library','node_modules']:
            (work/name).mkdir(); (work/name/'excluded').touch()
        place = self.scratch / 'place'; place.mkdir()
        subprocess.run(['zoxide','add',str(place)],env=self.env,check=True)
        session = self.scratch / 'manifest'; session.mkdir()
        subprocess.run([str(BIN/'explore-src'),'--init',str(work),str(session)],env=self.env,check=True)
        env = dict(self.env,EXPLORE_SESSION=str(session))
        rows = subprocess.run([str(BIN/'explore-src')],env=env,capture_output=True,check=True).stdout
        ids = re.findall(rb'explore://(g[A-Za-z0-9]+-[0-9]+)',rows)
        resolved = [subprocess.run([str(BIN/'explore-src'),'--resolve',i.decode()],env=env,capture_output=True,check=True).stdout.rstrip(b'\n').decode() for i in ids]
        self.assertEqual(resolved[0],str(place.resolve()))
        self.assertEqual([pathlib.Path(x).name for x in resolved[1:3]],['a-dir','b-dir'])
        direct=[x for x in resolved[3:] if pathlib.Path(x).parent==work]
        deeper=[x for x in resolved[3:] if pathlib.Path(x).parent!=work]
        self.assertEqual(set(deeper),{str(work/'a-dir/deep'),str(work/'a-dir/debug.log')})
        self.assertEqual({pathlib.Path(x).name for x in direct},set(HOSTILE+['.hidden','.ignore']))
        picks = [next(i for i,p in zip(ids,resolved) if pathlib.Path(p).name==name) for name in HOSTILE]
        subprocess.run([str(BIN/'explore-action'),'open',*[p.decode() for p in picks]],env=env,check=True)
        self.assertEqual((session/'result').read_bytes(), b'EXPLORE1\0open\0'+b''.join(bytes((work/name).resolve())+b'\0' for name in HOSTILE))
        # zoxide appears again on return to start, never in a different scope.
        (session/'scope').write_text(str((work/'a-dir').resolve())+'\n')
        rows2 = subprocess.run([str(BIN/'explore-src')],env=env,capture_output=True,check=True).stdout
        self.assertNotIn('◆'.encode(),rows2)
        (session/'scope').write_text(str(work.resolve())+'\n')
        rows3 = subprocess.run([str(BIN/'explore-src')],env=env,capture_output=True,check=True).stdout
        self.assertIn('◆'.encode(),rows3)
        # Navigation creates new generations without invalidating earlier IDs.
        for old_id, expected in zip(ids, resolved):
            old = subprocess.run([str(BIN/'explore-src'),'--resolve',old_id.decode()],env=env,capture_output=True,check=True)
            self.assertEqual(old.stdout,os.fsencode(expected)+b'\n')
        self.assertNotEqual(self.zsh('"$1" --resolve "$2"',BIN/'explore-src', '$(touch NEVER)',env=env,check=False).returncode,0)

    def test_source_chunk_boundaries_and_terminal_escaping(self):
        work = self.scratch/'chunks'; work.mkdir()
        fake = self.scratch/'chunks-bin'; fake.mkdir()
        zoxide = fake/'zoxide'; zoxide.write_text('#!/bin/zsh -f\nexit 0\n'); zoxide.chmod(0o755)
        payload = self.scratch/'chunks-payload'
        # Include every non-NUL ASCII control, Unicode/bidi, and invalid UTF-8.
        names = [b'sub/control-'+bytes([i]) for i in range(1,32)]
        names += [b'sub/delete-\x7f', 'sub/日本語\u202e'.encode(), b'sub/invalid-\xff', b'sub/final']
        data = b'\0'+b'\0'.join(b'./'+name for name in names)+b'\0./sub/unterminated'
        payload.write_bytes(data)
        fd = fake/'fd'
        fd.write_text(f'#!{sys.executable}\nimport os\nos.write(1, open(os.environ["SCAN_PAYLOAD"], "rb").read())\n')
        fd.chmod(0o755)
        env = dict(self.env,PATH=str(fake)+':'+self.env['PATH'],SCAN_PAYLOAD=str(payload))
        # The old read loop is the oracle for NUL/EOF behavior and ${(V)}.
        reference = self.zsh('while IFS= read -r -d $\'\\0\' p; do '
                             'p=${p#./}; p=${p%/}; [[ -n $p && $p != *$\'\\n\'* ]] || continue; '
                             'print -rn -- "${(V)p}"$\'\\0\'; done < "$1"',payload,env=env).stdout.split(b'\0')[:-1]
        for size in [1,7,65536]:
            with self.subTest(read_size=size):
                session = self.scratch/f'chunks-session-{size}'; session.mkdir()
                run_env = dict(env,EXPLORE_SESSION=str(session),SCAN_READ_SIZE=str(size))
                subprocess.run([str(BIN/'explore-src'),'--init',str(work),str(session)],env=run_env,check=True)
                rows = self.zsh('sysread() { argv[4]=$SCAN_READ_SIZE; builtin sysread "$@"; }; '
                                'src=$1; shift; source "$src"',BIN/'explore-src',env=run_env).stdout
                labels = re.findall(rb'\x1b\[39m\xc2\xb7 (.*?)\x1b\[0m',rows)
                self.assertEqual(labels,reference)
                manifest = next(session.glob('g*/manifest')).read_bytes().split(b'\n')[:-1]
                self.assertEqual(manifest,[bytes(work)+b'/'+n for n in names if b'\n' not in n])

    def test_symlink_directory_classification_without_traversal(self):
        work = self.scratch/'symlink-scope'; work.mkdir()
        outside = self.scratch/'symlink-target'; outside.mkdir()
        (outside/'unseen').touch()
        (work/'sub').mkdir()
        (work/'direct-link').symlink_to(outside,target_is_directory=True)
        (work/'sub/deep-link').symlink_to(outside,target_is_directory=True)
        session = self.scratch/'symlink-session'; session.mkdir()
        env = dict(self.env,EXPLORE_SESSION=str(session))
        subprocess.run([str(BIN/'explore-src'),'--init',str(work),str(session)],env=env,check=True)
        rows = subprocess.run([str(BIN/'explore-src')],env=env,capture_output=True,check=True).stdout
        self.assertIn('▸ sub/deep-link/'.encode(),rows)
        # Direct symlinks retain the existing non-directory glob classification.
        self.assertIn('· direct-link'.encode(),rows)
        self.assertNotIn(b'unseen',rows)

    def test_source_cancellation_reaps_scanner(self):
        for mode in ['term','pipe']:
            with self.subTest(mode=mode):
                base = self.scratch/f'cancel-{mode}'; base.mkdir()
                work = base/'scope'; work.mkdir()
                fake = base/'bin'; fake.mkdir()
                pidfile = base/'scanner-pid'
                release = base/'release'
                fd = fake/'fd'
                fd.write_text(f'#!{sys.executable}\nimport os, time\n'
                              'open(os.environ["SCAN_PID"], "w").write(str(os.getpid()))\n'
                              'os.write(1, b"./sub/early\\0")\n'
                              'while not os.path.exists(os.environ["SCAN_RELEASE"]): time.sleep(.01)\n'
                              'os.write(1, b"./sub/late\\0")\n'
                              'while True: time.sleep(.01)\n')
                fd.chmod(0o755)
                session = base/'session'; session.mkdir()
                env = dict(self.env,PATH=str(fake)+':'+self.env['PATH'],EXPLORE_SESSION=str(session),
                           SCAN_PID=str(pidfile),SCAN_RELEASE=str(release))
                subprocess.run([str(BIN/'explore-src'),'--init',str(work),str(session)],env=env,check=True)
                source = subprocess.Popen([str(BIN/'explore-src')],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                scanner = None
                try:
                    rows = b''
                    deadline = time.monotonic()+5
                    while b'sub/early' not in rows and time.monotonic()<deadline:
                        if select.select([source.stdout],[],[],.05)[0]:
                            chunk = os.read(source.stdout.fileno(),65536)
                            if not chunk: break
                            rows += chunk
                    self.assertIn(b'sub/early',rows)
                    scanner = int(pidfile.read_text())
                    if mode == 'term':
                        source.terminate()
                    else:
                        source.stdout.close()
                        release.touch()
                    source.wait(timeout=5)
                    self.assertNotEqual(source.returncode,0)
                    with self.assertRaises(ProcessLookupError):
                        os.kill(scanner,0)
                    scanner = None
                finally:
                    if source.poll() is None:
                        source.terminate()
                        try: source.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            source.kill()
                            source.wait(timeout=5)
                    if source.stdout and not source.stdout.closed: source.stdout.close()
                    source.stderr.close()
                    if scanner is not None:
                        try: os.kill(scanner,signal.SIGKILL)
                        except ProcessLookupError: pass

    def test_rows_stream_and_resolve_before_scan_finishes(self):
        work = self.scratch/'stream'; work.mkdir()
        (work/'sub').mkdir()
        for name in ['first', 'sub/early', 'sub/late']:
            (work/name).touch()
        fake = self.scratch/'stream-bin'; fake.mkdir()
        release = self.scratch/'release-scan'
        fd = fake/'fd'
        fd.write_text('#!/bin/zsh -f\nprint -rn -- $\'./sub/early\\0\'\n'
                      'while [[ ! -e $SCAN_RELEASE ]]; do sleep .01; done\n'
                      'print -rn -- $\'./sub/late\\0\'\n')
        fd.chmod(0o755)
        session = self.scratch/'stream-session'; session.mkdir()
        zoxide = self.scratch/'stream-zoxide'; zoxide.mkdir()
        env = dict(self.env, PATH=str(fake)+':'+self.env['PATH'],
                   EXPLORE_SESSION=str(session), SCAN_RELEASE=str(release),
                   _ZO_DATA_DIR=str(zoxide))
        subprocess.run([str(BIN/'explore-src'),'--init',str(work),str(session)],env=env,check=True)
        source = subprocess.Popen([str(BIN/'explore-src')],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            rows = b''
            deadline = time.monotonic()+5
            while b'sub/early' not in rows and time.monotonic()<deadline:
                if select.select([source.stdout],[],[],.05)[0]:
                    chunk = os.read(source.stdout.fileno(),65536)
                    if not chunk: break
                    rows += chunk
            self.assertIn(b'sub/early',rows, 'rows must arrive while fd is still gated')
            self.assertIsNone(source.poll())
            ids = re.findall(rb'explore://(g[A-Za-z0-9]+-[0-9]+)',rows)
            resolved = [subprocess.run([str(BIN/'explore-src'),'--resolve',i.decode()],env=env,capture_output=True,check=True).stdout.rstrip(b'\n') for i in ids]
            self.assertEqual(resolved,[bytes(work/'sub'),bytes(work/'first'),bytes(work/'sub/early')])
            release.touch()
            remaining, errors = source.communicate(timeout=5)
            self.assertEqual(source.returncode,0,errors)
            self.assertIn(b'sub/late',remaining)
        finally:
            release.touch()
            if source.poll() is None: source.terminate()
            source.communicate(timeout=5)

    def test_input_header_home_abbreviation_and_escaping(self):
        home = self.scratch/'header-home'; home.mkdir()
        config = home/'.config'; config.mkdir()
        child = home/'tab\tcontrol\x1b'; child.mkdir()
        sibling = self.scratch/'header-home-other'; sibling.mkdir()
        fake = self.scratch/'header-bin'; fake.mkdir()
        captured = self.scratch/'tv-args'
        tv = fake/'tv'
        tv.write_text('#!/bin/zsh -f\nprintf "%s\\0" "$@" > "$CAPTURE_ARGS"\nexit 130\n')
        tv.chmod(0o755)
        env = dict(self.env,HOME=str(home),PATH=str(fake)+':'+self.env['PATH'],CAPTURE_ARGS=str(captured))
        for folder, expected in [(home,'~/'),(config,'~/.config/'),
                                 (child,'~/tab\\tcontrol^[/'),(sibling,str(sibling)+'/')]:
            with self.subTest(folder=folder):
                result = subprocess.run([str(BIN/'explore-tv'),str(folder)],env=env,capture_output=True)
                self.assertEqual(result.returncode,130,result.stderr)
                args = captured.read_bytes().split(b'\0')
                self.assertEqual(args[args.index(b'--input-header')+1],expected.encode())

    def test_real_headless_neovim(self):
        socket = self.scratch / 'n.sock'
        # A short path is required by macOS sockaddr_un.
        if len(bytes(socket)) > 100:
            self.skipTest('TMPDIR too long for nvim socket; use a short EXPLORE_TEST_TMP')
        nvim = subprocess.Popen(['nvim','--headless','-u','NONE','-i','NONE','-n','--listen',str(socket)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=self.env)
        def rpc(expr):
            return subprocess.run(['nvim','--server',str(socket),'--remote-expr',expr],env=self.env,capture_output=True,check=True).stdout.decode().rstrip('\n')
        try:
            deadline=time.monotonic()+5
            while not socket.exists() and time.monotonic()<deadline:time.sleep(.02)
            self.assertTrue(socket.exists())
            rpc("setline(1, 'unsaved research')")
            original=int(rpc('bufnr()'))
            paths=[]
            for name in HOSTILE:
                p=self.scratch/('nvim-'+name);p.touch();paths.append(p)
            def dispatch(*p):
                self.zsh('source "$1"; shift; explore_nvim_open "$@"',BIN/'explore-dispatch',socket,nvim.pid,'open',*p)
            dispatch(paths[0])
            self.assertEqual(rpc("expand('%:p')"),str(paths[0].resolve()))
            self.assertEqual(rpc(f'getbufvar({original}, "&modified")'),'1')
            self.assertEqual(rpc(f'getbufline({original}, 1)[0]'),'unsaved research')
            dispatch(*paths)
            self.assertEqual(rpc('argc()'),str(len(paths)))
            for i,p in enumerate(paths):
                self.assertEqual(rpc(f'argv({i})'),str(p.resolve()))
            dispatch(self.scratch)
            self.assertEqual(rpc('getcwd()'),str(self.scratch.resolve()))
            for option in ['unload','delete','wipe']:
                rpc("execute('enew')")
                rpc(f"execute('setlocal bufhidden={option}')")
                rpc("setline(1, 'KEEP destructive bufhidden')")
                protected=int(rpc('bufnr()'))
                dispatch(paths[0])
                self.assertEqual(rpc(f'getbufvar({protected}, "&modified")'),'1')
                self.assertEqual(rpc(f'getbufline({protected}, 1)[0]'),'KEEP destructive bufhidden')
                self.assertEqual(rpc("expand('%:p')"),str(paths[0]))
            discovered=self.zsh('source "$1"; explore_nvim_socket "$2"; print -r -- "$REPLY"',BIN/'explore-dispatch',nvim.pid)
            self.assertEqual(discovered.stdout.rstrip(b'\n'),bytes(socket))
        finally:
            nvim.terminate()
            nvim.wait(timeout=5)

    def test_foreground_detection_branches(self):
        # Kernel-table fixtures cover shell/nvim/other and ambiguous or
        # missing terminal states. Real tty dispatch is checked end to end.
        fake=self.scratch/'ps-bin';fake.mkdir()
        ps=fake/'ps'
        ps.write_text('#!/bin/zsh\nif [[ $1 == -p ]]; then print -r -- "$PS_SHELL"; else print -r -- "$PS_GROUP"; fi\n');ps.chmod(0o755)
        cases=[('100 100 100 ttys099 /bin/zsh','', 'shell 100 ttys099 100'),('100 100 200 ttys099 /bin/zsh','200 200 /opt/homebrew/bin/nvim','nvim 200 ttys099 200'),('100 100 200 ttys099 /bin/zsh','200 200 /bin/sleep','other 0 ttys099 200'),('100 100 -1 ?? /bin/zsh','','other 0  0'),('100 100 200 ttys099 /bin/zsh','200 200 /bin/nvim\n201 200 /bin/nvim','other 0 ttys099 200')]
        for shell,group,expected in cases:
            env=dict(self.env,PATH=str(fake)+':'+self.env['PATH'],PS_SHELL=shell,PS_GROUP=group)
            result=self.zsh('source "$1"; explore_foreground 100 || true; print -r -- "${(j: :)reply}"',BIN/'explore-dispatch',env=env)
            self.assertEqual(result.stdout.decode().rstrip('\n'),expected)

    def test_new_window_literal_argv(self):
        target=self.scratch/"new pane '日本語$*.txt";target.touch()
        result=self.zsh('source "$1"; explore_tuios() { printf "%s\\0" "$@"; }; explore_new_window open "$2"',BIN/'explore-dispatch',target)
        self.assertEqual(result.stdout.split(b'\0')[:-1],[b'new-window',b'--cwd',bytes(target.parent),b'nvim',b'--',b'nvim',b'--',bytes(target)])

    def test_real_neovim_tui_client_server(self):
        socket=self.scratch/'t.sock'
        client,master=pty.fork()
        if client==0:
            os.execvpe('nvim',['nvim','-u','NONE','-i','NONE','-n','--listen',str(socket)],self.env)
        def drain():
            try:
                while True:
                    chunk=os.read(master,65536)
                    if not chunk:break
                    if b'\x1b[6n' in chunk:os.write(master,b'\x1b[1;1R')
            except OSError:
                pass
        thread=threading.Thread(target=drain,daemon=True);thread.start()
        try:
            deadline=time.monotonic()+5
            while not socket.exists() and time.monotonic()<deadline:time.sleep(.02)
            self.assertTrue(socket.exists())
            result=self.zsh('source "$1"; explore_nvim_socket "$2" || exit; printf "%s\\0%s" "$REPLY" "$REPLY_PID"',BIN/'explore-dispatch',client)
            found,server=result.stdout.split(b'\0')
            self.assertEqual(found,bytes(socket))
            self.assertGreater(int(server),0)
            path=self.scratch/"tui '日本語$*%#.txt";path.write_text('TUI regression\n')
            self.zsh('source "$1"; shift; explore_nvim_open "$@"',BIN/'explore-dispatch',socket,server.decode(),'open',path)
            rpc=subprocess.run(['nvim','--server',str(socket),'--remote-expr',"expand('%:p')"],env=self.env,capture_output=True,check=True)
            self.assertEqual(rpc.stdout.rstrip(b'\n'),bytes(path))
        finally:
            # Closing through RPC lets both the editor server and its TUI
            # client finish; keep draining until the client has exited.
            try:
                if socket.exists():
                    subprocess.run(['nvim','--server',str(socket),'--remote-expr',"execute('qa!')"],env=self.env,capture_output=True,timeout=3)
            except (OSError,subprocess.TimeoutExpired):
                pass
            deadline=time.monotonic()+3
            while time.monotonic()<deadline:
                pid,_=os.waitpid(client,os.WNOHANG)
                if pid:break
                time.sleep(.02)
            else:
                os.kill(client,signal.SIGTERM);os.waitpid(client,0)
            os.close(master);thread.join(timeout=1)


if __name__=='__main__':unittest.main()

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { findRuntimeViolation } from "./guard-runtimes.js";

const HOOK = join(import.meta.dir, "guard-runtimes.js");
const verdict = (command) => findRuntimeViolation(command, "/repo");

describe("blocks", () => {
  test.each([
    ["python script.py"],
    ["python3 -c 'print(1)'"],
    ["python3.11 -m venv .venv"],
    ["/usr/bin/python3 check.py"],
    [".venv/bin/python check.py"],
    ["pip install requests"],
    ["pip3 install -r requirements.txt"],
    ["pytest -q tests"],
    ["py.test tests"],
    ["node check.js"],
    ["nodejs server.js"],
    ["/opt/homebrew/bin/node --version"],
    // shells, wrappers, substitutions and inputs
    ["cd src && python3 check.py"],
    ["FOO=1 python3 check.py"],
    ["env PYTHONPATH=. python3 check.py"],
    ["sudo pip install x"],
    ["timeout 30 node server.js"],
    ["nohup node server.js &"],
    ["exec node server.js"],
    ["ls *.py | xargs python3 -m py_compile"],
    ["bash -lc 'python3 check.py'"],
    ['eval "node check.js"'],
    ["out=$(python3 -c 'print(1)')"],
    ['echo "$(node -v)"'],
    ["python3 - <<'EOF'\nprint(1)\nEOF"],
    ["bash <<EOF\npytest\nEOF"],
    ["sh -c 'cd x && node y.js'"],
    ["command node check.js"],
    // quoting, escaping and case do not hide the name
    ['"no"de check.js'],
    ["n\\ode check.js"],
    ["PYTHON3 check.py"],
    // more wrappers
    ["env --unset FOO node check.js"],
    ["arch -arm64 python3 check.py"],
    ["arch -arch x86_64 node check.js"],
    // options with attached values, read as getopt reads them
    ["sudo -uubuntu python3 check.py"],
    ["xargs -IFILE python3 FILE"],
    ["env -uTMP python3 check.py"],
    ["ssh -lme host python3 check.py"],
    ["ssh host -t python3 check.py"],
    ["ssh host -- python3 check.py"],
    ["echo 'python3 x' | ssh -lme host"],
    ["ssh host 'cd app && bash -s' <<'EOF'\npython3 x.py\nEOF"],
    ["ssh -o ProxyCommand='python3 proxy.py' host ls"],
    ["fish --command 'python3 x'"],
    ["fish -C 'node x.js'"],
    ["{ echo 'python3 x'; } | sh"],
    ["(echo 'python3 x') | sh"],
    ["sudo -iu me python3 check.py"],
    ["sudo -Eu me node check.js"],
    ["coproc python3 server.py"],
    ["coproc worker { node server.js; }"],
    // other Python programs
    ["ipython"],
    ["ipython3 -c 'print(1)'"],
    ["pypy3 check.py"],
    // find -exec, piped scripts and ssh
    ["find . -name '*.py' -exec python3 -m py_compile {} \\;"],
    ["find src -execdir node lint.js {} +"],
    ["echo 'python3 check.py' | sh"],
    ["printf 'node check.js\\n' | bash -s"],
    ["ssh host python3 check.py"],
    ["ssh -o ConnectTimeout=5 -p 2222 host 'cd app && pytest -q'"],
    ["ssh -t host 'bash -lc \"node check.js\"'"],
    ["ssh host <<'EOF'\npython3 check.py\nEOF"],
    ["ssh host bash -s <<'EOF'\npip install x\nEOF"],
  ])("%s", (command) => {
    expect(verdict(command)).toBeDefined();
  });
});

describe("allows", () => {
  test.each([
    ["uv run python check.py"],
    ["uv run --no-project --python 3.11 python -B check.py"],
    ["uv run --with pytest pytest -q"],
    ["uv pip install requests"],
    ["uvx ruff check ."],
    ["bun check.js"],
    ["bunx tsc --noEmit"],
    ["npm test"],
    ["npx vitest run"],
    ["pipx list"],
    ["nodemon --version"],
    ["grep -rn python ."],
    ["rg 'node check.js' docs"],
    ["echo python3 check.py"],
    ["git commit -m 'Run checks with pytest, never node'"],
    ["which python3 node"],
    ["command -v node"],
    ["command -pv python3"],
    ["type node"],
    ["brew upgrade node python@3.12"],
    ["cat <<'EOF' > run.sh\npython3 check.py\nEOF"],
    ["git log --oneline # python3 check.py"],
    ["ls node_modules/.bin"],
    ["bun run node_modules/.bin/vite build"],
    ["ssh host 'uv run python check.py'"],
    ["ssh -i ~/.ssh/key host ls node_modules"],
    ["ssh host"],
    ["echo 'python3 check.py' > run.sh"],
    ["echo 'python3 check.py' | tee notes.txt"],
    ["find . -name '*.py' -exec grep -l python3 {} +"],
    ["find . -name node_modules -prune"],
    ["sudo -u me uv run python check.py"],
    ["pipenv --version"],
  ])("%s", (command) => {
    expect(verdict(command)).toBeUndefined();
  });
});

test("scripts nested too deeply to follow are skipped, not blocked", () => {
  let command = "echo node_modules";
  for (let i = 0; i < 10; i++) command = `bash -c ${JSON.stringify(command)}`;
  expect(verdict(command)).toBeUndefined();
  expect(verdict(`${command}; python3 check.py`)).toBeDefined();
});

test("the reason names the command and the replacement", () => {
  expect(verdict("python3 check.py")).toContain("`uv run python");
  expect(verdict("node check.js")).toContain("`bun`");
});

describe("hook process", () => {
  const run = (stdin) => {
    const result = Bun.spawnSync({ cmd: [process.execPath, HOOK], stdin: Buffer.from(stdin) });
    return { code: result.exitCode, stderr: result.stderr.toString() };
  };
  const bash = (command) => run(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: "/tmp" }));

  test("blocks a bare runtime with exit 2 and the reason on stderr", () => {
    const result = bash("python3 check.py");
    expect(result.code).toBe(2);
    expect(result.stderr).toStartWith("Blocked by the guard-runtimes hook: `python3 check.py` runs python3 directly.");
  });

  test("allows uv run and other tools", () => {
    expect(bash("uv run python check.py")).toEqual({ code: 0, stderr: "" });
    expect(run(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } }))).toEqual({ code: 0, stderr: "" });
  });

  test("fails open on malformed input", () => {
    const result = run("not json");
    expect(result.code).not.toBe(0);
    expect(result.code).not.toBe(2);
  });
});

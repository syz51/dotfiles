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
    // other JavaScript package managers, also through bunx, even where a lockfile selects them
    ["npm test"],
    ["npm install"],
    ["npx vitest run"],
    ["pnpm install"],
    ["pnpx create-vite"],
    ["yarn build"],
    ["yarnpkg add x"],
    ["corepack enable"],
    ["vp run build"],
    ["vpx tsc"],
    ["sudo npm i -g pnpm"],
    ["cd app && PNPM_HOME=x pnpm store prune"],
    ["bunx pnpm@11 store prune"],
    ["bunx --bun npm install"],
    ["bun x yarn"],
    ["bunx node@22 check.js"],
    ["bunx --cwd app npm install"],
    ["bunx --env-file .env pnpm i"],
    ["bunx --registry https://r.example yarn"],
    ["bunx -p left-pad npm install"],
    ["bunx --package=pnpm@9 pnpm"],
    ["bun --bun x npm install"],
    ["bun --cwd app x pnpm i"],
    ["BUNX pnpm install"],
    ["NPM install"],
    ["Node check.js"],
    ["bunx vite-plus"],
    ["ssh host 'cd app && npm ci'"],
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
    ["echo $(echo python3 x.py) | sh"],
    ["echo $(case a in a) python3 x.py;; esac)"],
    ["cat <<EOF\n$(node -v)\nEOF"],
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
    ["ssh -lsunyizhe host python3 check.py"],
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
    // the Codex CLI: the user has only a Claude plan
    ["codex exec 'review this diff'"],
    ["codex -m gpt-6-luna exec hi"],
    ["/opt/homebrew/bin/codex review"],
    ["CODEX_HOME=/tmp/x codex app-server"],
    ["cd repo && codex"],
    ["bunx @openai/codex exec hi"],
    ["bunx @openai/codex@0.50 exec hi"],
    ["bun x codex exec hi"],
    ["ssh host 'codex exec hi'"],
    ["bash -lc 'codex exec hi'"],
    ["Codex exec hi"],
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
    ["bun install"],
    ["bun run test"],
    ["bunx vitest run"],
    ["bunx @vitejs/plugin-react"],
    ["bun x tsc"],
    ["bunx --cwd npm tsc"],
    ["bunx -p npm-check-updates ncu"],
    ["bun --cwd node x tsc"],
    ["grep -rn pnpm ."],
    ["cat pnpm-lock.yaml"],
    ["rm -rf ~/Library/pnpm"],
    ["brew uninstall pnpm yarn"],
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
    // reading Codex's files, or tools that only share the name
    ["ls ~/.codex/sessions"],
    ["grep -rn 'codex exec' ."],
    ["cat codex/AGENTS.md"],
    ["codex-skills daily --config c.json"],
    ["which codex"],
    ["bun claude/factory/metrics/cli.js --codex-home ~/.codex"],
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
  expect(verdict("node check.js")).toContain("`bun <file>`");
  expect(verdict("node check.js")).not.toContain("lockfile");
  expect(verdict("pnpm install")).toContain("`bun install`");
  expect(verdict("bunx pnpm@11 store prune")).toContain("runs pnpm through bunx");
  expect(verdict("codex exec hi")).toContain("only a Claude plan");
  expect(verdict("codex exec hi")).toContain("Claude provider");
  expect(verdict("codex exec hi")).not.toContain("bun");
  expect(verdict("bunx @openai/codex exec hi")).toContain("runs @openai/codex through bunx");
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

  test("blocks the Codex CLI with exit 2 before it starts", () => {
    const result = bash("codex exec 'say hi'");
    expect(result.code).toBe(2);
    expect(result.stderr).toStartWith("Blocked by the guard-runtimes hook: `codex exec say hi` runs codex.");
  });

  // Codex sends its exec_command calls as tool_name Bash with the command string and the
  // call's workdir as cwd, plus fields Claude Code does not send.
  test("blocks a bare runtime in Codex-shaped input", () => {
    const codex = (command) => run(JSON.stringify({
      session_id: "s", turn_id: "t", tool_use_id: "call_1", transcript_path: null, cwd: "/tmp", hook_event_name: "PreToolUse",
      model: "gpt-5.5", permission_mode: "default", tool_name: "Bash", tool_input: { command },
    }));
    const result = codex("python3 -c 1");
    expect(result.code).toBe(2);
    expect(result.stderr).toStartWith("Blocked by the guard-runtimes hook: `python3 -c 1` runs python3 directly.");
    expect(codex("uv run python -c 1")).toEqual({ code: 0, stderr: "" });
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

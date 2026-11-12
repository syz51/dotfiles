import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Transcript, writeProjects } from "../lib/testing/transcripts.js";
import { loadSessions } from "../lib/transcripts.js";
import { aiAttribution, forcePush, forcePushProblem, gitPushes, packageRunner, reviewSkipped, runDetectors, sessionActions, shellChanges, shellEdits, shellFileEdit, simpleCommands, ultraEffort } from "./detectors.js";
import { boardCheckouts, gitCheckout, gitIgnored, loadReviewScope, locate, realFile, REVIEW_SCOPE_FILE, repoName, reviewMatcher } from "./review-scope.js";

const cleanup = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

let clock = 0;
const call = (name, input, extra = {}) => ({ id: `t${++clock}`, name, input, at: new Date(Date.UTC(2026, 10, 1, 0, 0, clock)).toISOString(), gitBranch: "feature", agent: null, ok: true, ...extra });
const bash = (command, extra) => call("Bash", { command }, extra);
const actions = (calls, { prompts = [], commands = [], cwd = null } = {}) => ({ calls, prompts, commands, cwd });
const prompt = (text, at = "2026-01-01T00:00:00.000Z") => ({ at, text, source: "sdk" });

describe("package-runner", () => {
  test.each([
    "npm install",
    "npx prettier --write .",
    "pnpm test",
    "yarn build",
    "corepack enable",
    "bunx pnpm@11 store prune",
    "bun x npm install",
    "node check.js",
    "nodejs server.js",
    "pnpx create-vite",
    "yarnpkg add x",
    "NPM install",
    "BUNX pnpm install",
    "vp install",
    "vpx npm install",
    "vp exec node x.js",
    "vp node check.js",
    "vpx check.js",
    "bunx --cwd app npm install",
    "ssh host 'npm ci'",
    "pip install requests",
    "pytest -q",
    "python3 script.py",
    "python -m http.server",
    "cd app && .venv/bin/python manage.py test",
    "cat data.json | python3 -c 'import json,sys; print(json.load(sys.stdin))'",
    "cd /tmp && python3 - <<'EOF'\nprint(1)\nEOF",
    "bash -c 'npm test'",
    "git status\npython3 - <<'EOF'\nprint(1)\nEOF",
    "cd x\nnpm install",
    "timeout 60 python3 -m pytest",
    "sudo pip install x",
    "env FOO=1 npm i",
    "if python3 x.py; then echo; fi",
    "for f in a; do python3 $f; done",
    "ls *.py | xargs -n 1 python3",
  ])("flags %p", (command) => {
    const result = packageRunner(actions([bash(command)]));
    expect(result.verdict).toBe("fail");
    expect(result.hits[0].evidence).toContain(command.split("\n")[0].slice(0, 20));
  });

  test.each([
    "bun test",
    "bunx prettier --check .",
    "bunx --cwd npm tsc",
    "bun install",
    "bun run test",
    "vp run build",
    "vpx tsc",
    "bunx --bun vp --version",
    "vp check",
    "uv run pytest -q",
    "uv run --no-project python -B script.py",
    "UV_OFFLINE=1 uv run python3 x.py",
    "grep -r npm docs",
    "echo 'python3 is not run here'",
    "for c in \"npm test\" \"pip install x\"; do echo \"$c\"; done",
    "tuios list-options 2>&1 | grep -iE 'hook|custom|pip' | head -40",
    "cat > t.sh <<'EOF'\npython3 x.py\nEOF\nbun t.sh",
    // Lookups check that a program exists; they run nothing.
    "command -v python3 && echo ok",
    "command -V pip",
    "command -pv npm >/dev/null || echo missing",
    "type python3; which pip; hash pytest",
  ])("passes %p", (command) => {
    expect(packageRunner(actions([bash(command)])).verdict).toBe("pass");
  });

  test("a command over ssh gets no node exception, as in the hook", () => {
    // A gone directory of a call the hook let run allows node, as the test above shows.
    const gone = join(tmpdir(), "detectors-gone-t3code-worktree", "x");
    expect(packageRunner(actions([bash(`bun --cwd ${gone} x node x.js`)])).verdict).toBe("pass");
    for (const command of [`ssh host 'cd ${gone} && node x.js'`, `ssh host bun --cwd ${gone} x node x.js`, `ssh host env -C ${gone} node x.js`]) {
      expect(packageRunner(actions([bash(command, { cwd: gone })])).hits[0]?.tool).toBe("node");
    }
  });

  test("`command` without a lookup option still runs its program", () => {
    expect(simpleCommands("command -v python3 && echo ok")).toEqual([["command", "-v", "python3"], ["echo", "ok"]]);
    expect(simpleCommands("command python3 x.py")).toEqual([["python3", "x.py"]]);
    expect(packageRunner(actions([bash("command python3 x.py")])).verdict).toBe("fail");
    expect(packageRunner(actions([bash("command -p pip install x")])).verdict).toBe("fail");
  });

  test("names the blocked tool, also behind bunx", () => {
    expect(packageRunner(actions([bash("cd app && bunx pnpm@9 install")])).hits[0].tool).toBe("pnpm");
  });

  test("is na without any Bash call", () => {
    expect(packageRunner(actions([call("Read", { file_path: "/a" })])).verdict).toBe("na");
  });

  // As guard-runtimes allows, node passes in a T3 Code checkout, and npm still fails there.
  test("node passes in a T3 Code checkout only, judged in each call's directory", () => {
    const fork = realpathSync(mkdtempSync(join(tmpdir(), "detectors-t3code-")));
    cleanup.push(fork);
    expect(spawnSync("git", ["init", "-q", fork]).status).toBe(0);
    expect(spawnSync("git", ["-C", fork, "remote", "add", "origin", "git@github.com:syz51/t3code.git"]).status).toBe(0);
    expect(packageRunner(actions([bash("node scripts/dev-runner.ts dev")], { cwd: fork })).verdict).toBe("pass");
    expect(packageRunner(actions([bash("npx x")], { cwd: fork })).verdict).toBe("fail");
    expect(packageRunner(actions([bash(`cd ${fork} && node x.js`)])).verdict).toBe("pass");
    expect(packageRunner(actions([bash("node x.js")], { cwd: tmpdir() })).verdict).toBe("fail");
    // The session started elsewhere, and a later call ran in the checkout, or the reverse.
    expect(packageRunner(actions([bash("node x.js", { cwd: fork })], { cwd: tmpdir() })).verdict).toBe("pass");
    expect(packageRunner(actions([bash("node x.js", { cwd: tmpdir() })], { cwd: fork })).verdict).toBe("fail");
  });

  // A T3 worktree is deleted after its merge, so the hook's verdict at the time decides.
  test("node in a directory that is gone passes unless the hook refused it", () => {
    const gone = join(tmpdir(), "detectors-gone-t3code-worktree", "x");
    expect(packageRunner(actions([bash("node x.js", { cwd: gone })])).verdict).toBe("pass");
    expect(packageRunner(actions([bash("node x.js", { cwd: gone, ok: false, runtimeBlocked: true })])).verdict).toBe("fail");
    expect(packageRunner(actions([bash("node x.js", { cwd: gone, ok: null })])).verdict).toBe("fail");
    expect(packageRunner(actions([bash("pnpm i", { cwd: gone })])).verdict).toBe("fail");
  });

  test("records whether the guard-runtimes hook refused a call", () => {
    const records = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "node x.js" } }, { type: "tool_use", id: "b", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "a", is_error: true, content: [{ type: "text", text: "PreToolUse:Bash hook error: Blocked by the guard-runtimes hook: `node x.js` runs node." }] },
        { type: "tool_result", tool_use_id: "b", content: "x.js" },
      ] } },
    ];
    const { calls } = sessionActions({ inheritedPrompts: [], prompts: [], cwd: null }, { main: records, subagents: [] });
    expect(calls.map(({ id, ok, runtimeBlocked }) => ({ id, ok, runtimeBlocked }))).toEqual([
      { id: "a", ok: false, runtimeBlocked: true },
      { id: "b", ok: true, runtimeBlocked: false },
    ]);
  });

  // guard-runtimes also blocks the codex CLI, but this dimension scores the uv and bun rule only.
  test("a codex call is not a package-runner failure", () => {
    expect(packageRunner(actions([bash("codex exec hi")])).verdict).toBe("pass");
    expect(packageRunner(actions([bash("bunx @openai/codex exec hi")])).verdict).toBe("pass");
  });
});

describe("shell-file-edit", () => {
  test.each([
    ["sed -i '' 's/a/b/' src/app.js", "sed in place", "src/app.js"],
    ["sed -i.bak -e 's/a/b/' README.md", "sed in place", "README.md"],
    ["perl -0pi -e 's|a|b|' claude/PLAN.md && git diff", "perl in place", "claude/PLAN.md"],
    ["cat > notes.md <<'EOF'\n# Notes\nEOF", "cat into a file", "notes.md"],
    ["cd ~/app && cat <<EOF >> src/config.toml\nkey = 1\nEOF", "cat into a file", "src/config.toml"],
    ["echo 'export X=1' >> ~/.zshrc", "echo into a file", "~/.zshrc"],
    ["printf '%s\\n' '/target/' > tools/.gitignore", "printf into a file", "tools/.gitignore"],
    ["echo '' >\"$HOME/.config/x.conf\"", "echo into a file", "~/.config/x.conf"],
    ["tee -a docs/log.md <<'EOF' >/dev/null\nline\nEOF", "tee into a file", "docs/log.md"],
    ["echo line | sudo tee /etc/hosts", "tee into a file", "/etc/hosts"],
    ["cd /tmp/x && cd ~/repo && sed -i '' 's/a/b/' a.txt", "sed in place", "a.txt"],
    ["P=src/main.rs; sed -i '' 's/a/b/' $P", "sed in place", "src/main.rs"],
    // Redirects and comments after the files, other option forms, several files.
    ["sed -i '' 's/a/b/' a.txt > /dev/null", "sed in place", "a.txt"],
    ["sed -i '' 's/a/b/' a.txt 2>&1 | tail", "sed in place", "a.txt"],
    ["sed -i '' 's/a/b/' src/app.js  # fix typo", "sed in place", "src/app.js"],
    ["sed -Ei 's/a/b/' a.txt", "sed in place", "a.txt"],
    ["sed --in-place -e 's/a/b/' -e 's/c/d/' a.txt", "sed in place", "a.txt"],
    ["ruby -i -pe 'gsub(/a/, \"b\")' a.txt", "ruby in place", "a.txt"],
    ["perl -Ilib -pi.bak -e 's/a/b/' a.txt", "perl in place", "a.txt"],
    // Pipes, redirects without spaces and other redirect operators.
    ["cat <<'EOF' | tee src/a.txt\nx\nEOF", "tee into a file", "src/a.txt"],
    ["cat <<EOF | sudo tee /etc/x > /dev/null\nx\nEOF", "tee into a file", "/etc/x"],
    ["echo hi>a.txt", "echo into a file", "a.txt"],
    ["echo 'x'>>a.txt", "echo into a file", "a.txt"],
    ["echo x &> a.txt", "echo into a file", "a.txt"],
    ["echo x >| a.txt", "echo into a file", "a.txt"],
    ["cat >file<<EOF\nx\nEOF", "cat into a file", "file"],
    ["cat <<< 'x' > a.txt", "cat into a file", "a.txt"],
    // A cd in a subshell ends with it; only tee fed by the agent's text counts.
    ["(cd /tmp/x && echo > a); echo > y", "echo into a file", "y"],
    ["echo x | tee a.txt; cargo build | tee build.log", "tee into a file", "a.txt"],
    // Inline scripts name the files they write when a literal says so.
    ["uv run --no-project python - <<'EOF'\nfrom pathlib import Path\np = Path('src/x.rs'); p.write_text(p.read_text().replace('a', 'b'))\nEOF", "inline script writing", "src/x.rs"],
    ["python3 - <<'EOF'\ns = open('README.md').read()\nopen('README.md', 'w').write(s)\nEOF", "inline script writing", "README.md"],
    ["bun -e 'const fs = require(\"fs\"); fs.writeFileSync(\"package.json\", \"{}\")'", "inline script writing", "package.json"],
    ["uv run python -I -c \"import json; json.dump({}, open('/Users/me/app/a.json', 'w'))\"", "inline script writing", "/Users/me/app/a.json"],
    ["cd /tmp/work && python3 - <<'EOF'\nopen('/Users/me/app/a.json', 'w').write('{}')\nEOF", "inline script writing", "/Users/me/app/a.json"],
    ["python3 - <<'EOF'\nwith open(Path('a.txt'), 'w') as f: f.write('x')\nEOF", "inline script writing", "a.txt"],
    ["python3 -c 'x' && python3 -c \"open('a', 'w')\"", "inline script writing", "a"],
    ["uv run - <<'EOF'\nopen('a.txt', 'w').write('x')\nEOF", "inline script writing", "a.txt"],
    ["deno eval 'Deno.writeTextFileSync(\"a.txt\", \"x\")'", "inline script writing", "a.txt"],
    ["python3 - <<'EOF'\nrows = open('/Users/me/data.jsonl').read()\nopen('/tmp/out.json', 'w').write(rows)\nopen('notes.md', 'w').write(rows)\nEOF", "inline script writing", "notes.md"],
  ])("flags %p", (command, how, file) => {
    expect(shellEdits(command)).toEqual([{ how, file }]);
    const result = shellFileEdit(actions([bash(command)]));
    expect(result.verdict).toBe("fail");
    expect(result.hits[0]).toMatchObject({ files: [file] });
    expect(result.hits[0].evidence).toStartWith(`${how} ${file}: `);
  });

  test.each([
    ["python3 - <<'EOF'\nfrom pathlib import Path\nfor p in Path('src').glob('*.py'): p.write_text(p.read_text().replace('a', 'b'))\nprint('/tmp/done')\nEOF", "inline script writing files"],
    ["python3 - <<'EOF'\nimport json\njson.dump({}, open(str(p), 'w'))\nEOF", "inline script writing files"],
    ["find . -name '*.md' | xargs sed -i '' 's/a/b/'", "sed in place"],
  ])("flags an edit of files it cannot name: %p", (command, how) => {
    expect(shellEdits(command)).toEqual([{ how, file: null }]);
  });

  test.each([
    // Scratch, devices and file descriptors.
    "cat > /tmp/msg.txt <<'EOF'\nhello\nEOF",
    "echo x > \"$TMPDIR/x\"",
    "printf 'a' > /private/tmp/claude-501/scratchpad/a.txt",
    "echo done >/dev/null 2>&1; echo err >&2",
    "cd /private/tmp/claude-501/s/scratchpad && cat > worker.md <<'EOF'\nx\nEOF",
    "S=/private/tmp/claude-501/s/scratchpad; mkdir -p $S/a && cd $S/a && printf 'x' > b.txt && sed -i '' 's/x/y/' b.txt",
    "cd \"$TMPDIR/fallback\" && sed -i '' 's/a/b/' scripts/harness.sh",
    "uv run python - <<'EOF'\nopen('/tmp/out.json', 'w').write('{}')\nEOF",
    "cd /private/var/folders/x/T/review && python3 - <<'EOF'\nopen('a.py', 'w').write('')\nEOF",
    // Targets built at run time are unknown.
    "echo x > \"$out\"",
    "printf x > $(mktemp)",
    // Other programs' output, reads and scripts from files.
    "git diff > fix.patch",
    "cargo build 2>&1 | tee build.log",
    "sed -n 1,20p src/app.js",
    "perl -ne 'print if /x/' a.txt",
    "uv run python - <<'EOF'\nprint(open('README.md').read())\nEOF",
    "python3 -c 'import sys; sys.stdout.write(\"x\")'",
    "uv run python tools/gen.py > out.txt",
    // Text only: quoted, in a comment, or inside a heredoc body.
    "git commit -m \"use sed -i '' to fix > a.txt\"",
    "cat > /tmp/fix.sh <<'EOF'\nsed -i '' 's/a/b/' src/app.js\necho x > README.md\nEOF\nbash /tmp/fix.sh",
    "echo '>>> Running tests'; echo \"1>2\"; printf '>%s\\n' x",
    "git commit -m 'fix' && python3 -c 'import json'  # open('a', 'w')",
    "python3 script.py; python3 -c 'print(1)'; echo \"open('x', 'w')\"",
    // Options that are not in-place edits, and reads that look like writes.
    "perl -MList::Util=sum -ne 'print sum(split)' data.txt",
    "perl -Mstrict -we 'print 1' a.txt",
    "python3 -c \"import json, os; print(json.load(open(os.path.join(root, 'agents.json'))))\"",
    // Scratch folders without a trailing slash, and folders made at run time.
    "cd /tmp && cat > notes.md <<EOF\nx\nEOF",
    "cd /private/tmp && echo > a; cd /var/tmp && echo > b",
    "sed -i '' 's/a/b/' /tmp/x",
    "tmp=$(mktemp -d) && cd \"$tmp\" && echo x > a.txt",
    "cd \"$(mktemp -d)\" && echo hi > a",
    "cd $(mktemp -d) && echo hi > a",
    // Scripts that read real files but write only scratch.
    "uv run python - <<'EOF'\nimport json\nrows = json.load(open('/Users/me/.claude/projects/x.jsonl'))\njson.dump(rows, open('/tmp/out.json', 'w'))\nEOF",
    "python3 - <<'EOF'\nimport os\nout = os.path.join('/private/tmp/claude/x', 'a.json')\nopen(out, 'w').write('{}')\nEOF",
  ])("passes %p", (command) => {
    expect(shellEdits(command)).toEqual([]);
  });

  test("applies to sessions that edited files: na without edits, pass with the edit tools only", () => {
    expect(shellFileEdit(actions([bash("git status"), call("Read", { file_path: "/a" })])).verdict).toBe("na");
    expect(shellFileEdit(actions([bash("git status"), call("Edit", { file_path: "/a", old_string: "a", new_string: "b" })])).verdict).toBe("pass");
    const result = shellFileEdit(actions([call("Write", { file_path: "/a", content: "" }), bash("sed -i '' 's/a/b/' a.txt && echo x >> b.txt", { agent: "agent-1" })]));
    expect(result.verdict).toBe("fail");
    expect(result.hits).toEqual([expect.objectContaining({ agent: "agent-1", files: ["a.txt", "b.txt"] })]);
    expect(result.hits[0].evidence).toStartWith("sed in place a.txt, echo into a file b.txt: ");
  });
});

describe("ai-attribution", () => {
  test.each([
    "git commit -m \"Fix bug\n\nCo-Authored-By: Claude <noreply@anthropic.com>\"",
    "git -C repo commit -m 'x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'",
    "gh pr create --title x --body \"Done\n\nGenerated with Claude Code\"",
    "gh pr comment 5 --body '🤖 looks good'",
  ])("flags %p", (command) => {
    expect(aiAttribution(actions([bash(command)])).verdict).toBe("fail");
  });

  test("passes a plain commit and PR; na without either", () => {
    expect(aiAttribution(actions([bash("git commit -m 'Fix the login bug'"), bash("gh pr create --title x --body 'Fixes #3'")])).verdict).toBe("pass");
    expect(aiAttribution(actions([bash("echo 'Co-Authored-By: Claude'"), bash("git status")])).verdict).toBe("na");
  });

  test("checks MCP pull request bodies too", () => {
    const result = aiAttribution(actions([call("mcp__github__create_pull_request", { title: "x", body: "Generated with Claude Code" })]));
    expect(result.verdict).toBe("fail");
  });
});

describe("force-push", () => {
  test.each([
    ["git push --force origin feature", "without --force-with-lease"],
    ["git push -f", "without --force-with-lease"],
    ["git push -uf origin feature", "without --force-with-lease"],
    ["git push origin +feature", "without --force-with-lease"],
    ["git push --force-with-lease origin feature", "explicit <ref>:<sha>"],
    ["git push --force-with-lease=feature origin feature", "explicit <ref>:<sha>"],
    ["git push --force-with-lease=main:0123abcd origin main", "default branch"],
    ["git push --force-with-lease=feature:0123abcd origin feature:master", "default branch"],
    ["git push -f origin main", "default branch"],
    ["timeout 30 git push --force origin feature", "without --force-with-lease"],
    ["bash -lc 'git push --force origin feature'", "without --force-with-lease"],
    ["cd repo && git push --force origin feature 2>&1 | tail -3", "without --force-with-lease"],
    ["git push --force-with-lease=HEAD:abcdef1 origin HEAD", "default branch", "main"],
    ["git push --force origin +HEAD", "default branch", "master"],
    // A mirror push force-updates every remote ref, with or without a force option.
    ["git push --mirror origin", "mirror push"],
    ["git push --mirror --force-with-lease=feature:0123abcd origin", "mirror push"],
    // Forcing all branches forces main too, whatever lease names another branch.
    ["git push --all --force origin", "all branches"],
    ["git push --all -f", "all branches"],
    ["git push --all --force-with-lease=feature:0123abcd origin", "all branches"],
    ["git push --branches --force-with-lease origin", "all branches"],
  ])("flags %p", (command, problem, gitBranch = "feature") => {
    const result = forcePush(actions([bash(command, { gitBranch })]));
    expect(result.verdict).toBe("fail");
    expect(result.hits[0].evidence).toContain(problem);
  });

  test.each([
    "git push origin feature",
    "git push -u origin HEAD",
    "git push --force-with-lease=feature:0123abcdef origin feature",
    "git push --force-with-lease=refs/heads/feature:0123abcdef0123abcdef0123abcdef0123abcdef origin HEAD:feature",
    // HEAD is the session's current branch, here "feature": an explicit lease on it.
    "git push --force-with-lease=HEAD:abcdef1 origin HEAD",
    // Pushing all branches without a force fast-forwards only.
    "git push --all origin",
  ])("passes %p", (command) => {
    expect(forcePush(actions([bash(command)])).verdict).toBe("pass");
  });

  test("ignores pushes that are only text: quoted, echoed or in a heredoc", () => {
    const commands = [
      "for c in \"git push --force origin main\" \"git push -f\"; do bun probe.js \"$c\"; done",
      "echo 'git push --force origin main' | bun hook.js",
      "cat > t.js <<'EOF'\ngit push --force origin main\nEOF\nbun t.js",
    ];
    expect(forcePush(actions(commands.map((command) => bash(command)))).verdict).toBe("na");
  });

  test("a push without a refspec targets the session's current branch", () => {
    expect(forcePushProblem(["--force-with-lease=HEAD:0123abcd"], "main")).toBe("force push to a default branch");
    expect(forcePushProblem(["--force-with-lease=HEAD:0123abcd"], "feature")).toBeNull();
    expect(forcePush(actions([bash("git push --force-with-lease=x:0123abcd", { gitBranch: "master" })])).verdict).toBe("fail");
  });

  test("mirror and forced all-branch pushes cover main whatever the lease names", () => {
    expect(forcePushProblem(["--mirror", "--force-with-lease=feature:abc1234"], "x")).toContain("mirror push");
    expect(forcePushProblem(["--mirror"], "x")).toContain("mirror push");
    expect(forcePushProblem(["--all", "--force-with-lease=feature:abc1234"], "x")).toContain("all branches");
    expect(forcePushProblem(["--all", "origin", "+feature"], "x")).toContain("all branches");
    expect(forcePushProblem(["--all", "origin"], "x")).toBeNull();
  });

  test("reads push arguments through wrappers and options with values", () => {
    expect(gitPushes("sudo -u me git -C repo push -o ci.skip origin x")).toEqual([["-o", "ci.skip", "origin", "x"]]);
    expect(forcePushProblem(["-o", "f", "origin", "x"])).toBeNull();
    expect(simpleCommands("eval \"git push -f\"; ls")).toEqual([["git", "push", "-f"], ["ls"]]);
  });
});

describe("ultra-effort", () => {
  test("flags an ultra code review, fast mode or ultra effort no prompt asked for", () => {
    const result = ultraEffort(actions([
      call("Skill", { skill: "code-review", args: "ultra" }),
      call("Edit", { file_path: "/u/.claude/settings.json", old_string: "{", new_string: "{\"fastMode\": true," }),
      bash("jq '.effortLevel = \"ultrathink\"' ~/.claude/settings.json > t && mv t ~/.claude/settings.json"),
    ], { prompts: [prompt("Review my change")] }));
    expect(result.verdict).toBe("fail");
    expect(result.hits.map((hit) => hit.mode)).toEqual(["ultra review", "fast", "ultra effort"]);
  });

  test("passes when a prompt or slash command asked first", () => {
    const review = call("Skill", { skill: "code-review", args: "ultra origin/main..HEAD" });
    expect(ultraEffort(actions([review], { prompts: [prompt("Run an ultra review of this")] })).verdict).toBe("pass");
    expect(ultraEffort(actions([review], { commands: [{ name: "/code-review", args: "ultra", at: "2026-01-01T00:00:00.000Z" }] })).verdict).toBe("pass");
  });

  test("a prompt that forbids the mode, or asks only after the call, does not count as asking", () => {
    const review = call("Skill", { skill: "code-review", args: "ultra" });
    expect(ultraEffort(actions([review], { prompts: [prompt("Never use an ultra review here.")] })).verdict).toBe("fail");
    expect(ultraEffort(actions([review], { prompts: [prompt("ultra review please", "2099-01-01T00:00:00.000Z")] })).verdict).toBe("fail");
  });

  test("only commands that write a settings file turn a mode on", () => {
    const writes = [
      "sed -i '' 's/\"effortLevel\": \"high\"/\"effortLevel\": \"ultrathink\"/' ~/.claude/settings.json",
      "echo '{\"effortLevel\": \"ultracode\"}' > .claude/settings.local.json",
      "jq '.fastMode = true' settings.json | tee settings.json",
      "perl -pi -e 's/\"effortLevel\": \"high\"/\"effortLevel\": \"ultrathink\"/' ~/.claude/settings.json",
      "python3 - <<'EOF'\nimport json\np = '/u/.claude/settings.json'\ns = json.load(open(p))\ns['effortLevel'] = 'ultrathink'\njson.dump(s, open(p, 'w'))\nEOF",
      "bun -e 'const f = \"settings.json\"; const s = await Bun.file(f).json(); s.fastMode = true; await Bun.write(f, JSON.stringify(s))'",
    ];
    expect(ultraEffort(actions(writes.map((command) => bash(command)))).hits.map((hit) => hit.mode)).toEqual(["ultra effort", "ultra effort", "fast", "ultra effort", "ultra effort", "fast"]);
    const reads = [
      "grep -n 'ultrathink' ~/.claude/settings.json",
      "jq '.effortLevel' ~/.claude/settings.json | grep -c ultracode",
      "cat ~/.claude/settings.json | grep '\"fastMode\": true'",
      "python3 -c 'import json; print(json.load(open(\"settings.json\"))[\"effortLevel\"] == \"ultrathink\")'",
      // A write that turns ultra effort off.
      "sed -i '' 's/\"ultrathink\"/\"high\"/' ~/.claude/settings.json",
    ];
    expect(ultraEffort(actions(reads.map((command) => bash(command)))).verdict).toBe("pass");
  });

  test("an edit is judged by the setting it turns on", () => {
    const edit = (new_string) => call("Edit", { file_path: "/u/.claude/settings.json", old_string: "x", new_string });
    const modes = (calls) => ultraEffort(actions(calls)).hits.map((hit) => hit.mode);
    expect(modes([edit('"fastMode": false, // ultrathink is for another day')])).toEqual([]);
    expect(modes([edit('"fastMode": false,\n"effortLevel": "ultrathink"')])).toEqual(["ultra effort"]);
    expect(modes([call("Write", { file_path: "/u/.claude/settings.json", content: '{"fastMode": true, "effortLevel": "ultracode"}' })])).toEqual(["fast", "ultra effort"]);
    expect(modes([call("Edit", { file_path: "/u/.claude/settings.json", old_string: '"high"', new_string: '"ultrathink"' })])).toEqual(["ultra effort"]);
  });

  test("passes ordinary reviews and skills", () => {
    expect(ultraEffort(actions([call("Skill", { skill: "code-review", args: "xhigh" }), call("Skill", { skill: "frontend-ui" })])).verdict).toBe("pass");
  });
});

test("runDetectors reads the main session and its subagents from the transcript files", () => {
  const main = new Transcript({ cwd: "/nonexistent/project" })
    .prompt("Ship it")
    .tool("Bash", { command: "git commit -m 'Ship\n\nCo-Authored-By: Claude <x>'" }, "ok")
    .tool("Agent", { subagent_type: "worker", description: "push" }, "done")
    .compact();
  const agent = new Transcript({ sessionId: main.sessionId }).tool("Bash", { command: "git push --force origin feature" }, "ok").tool("Bash", { command: "npm test" }, "ok")
    .tool("Bash", { command: "sed -i '' 's/a/b/' README.md" }, "ok");
  const root = writeProjects([{ transcript: main, subagents: [{ id: "agent-a1", meta: { agentType: "worker" }, transcript: agent }] }]);
  cleanup.push(root);
  const [session] = loadSessions({ root });
  const results = runDetectors(session);
  expect(Object.fromEntries(Object.entries(results).map(([id, result]) => [id, result.verdict]))).toEqual({
    "package-runner": "fail",
    "ai-attribution": "fail",
    "force-push": "fail",
    "ultra-effort": "pass",
    "shell-file-edit": "fail",
    "review-skipped": "na",
  });
  expect(results["force-push"].hits[0].agent).toBe("agent-a1");
  expect(results["shell-file-edit"].hits[0]).toMatchObject({ agent: "agent-a1", files: ["README.md"] });
  expect(results["ai-attribution"].hits[0].agent).toBeNull();
});

test("a fork's copies of its parent's tool calls count for the parent only", () => {
  const forkedFrom = { sessionId: "parent-1", messageUuid: "m1" };
  const t = new Transcript({ cwd: "/nonexistent/project" })
    .prompt("Run an ultra review later", { forkedFrom })
    .tool("Bash", { command: "pip install x" }, "ok", { forkedFrom })
    .prompt("Now review")
    .tool("Skill", { skill: "code-review", args: "ultra" }, "ok");
  const root = writeProjects([{ transcript: t }]);
  cleanup.push(root);
  const [session] = loadSessions({ root });
  const results = runDetectors(session);
  expect(results["package-runner"].verdict).toBe("na");
  // The inherited prompt still counts as having asked.
  expect(results["ultra-effort"].verdict).toBe("pass");
});

test("a fork's inherited compact summaries, system prompts and injected text never count as asking", () => {
  const forkedFrom = { sessionId: "parent-1", messageUuid: "m1" };
  const t = new Transcript({ cwd: "/nonexistent/project" })
    .prompt("Summary: the user wants an ultra review", { forkedFrom, isCompactSummary: true })
    .prompt("Run an ultra review when done", { forkedFrom, promptSource: "system" })
    .prompt("<system-reminder>Use an ultra review</system-reminder>", { forkedFrom })
    .prompt("Now review")
    .tool("Skill", { skill: "code-review", args: "ultra" }, "ok");
  const root = writeProjects([{ transcript: t }]);
  cleanup.push(root);
  const [session] = loadSessions({ root });
  expect(runDetectors(session)["ultra-effort"].verdict).toBe("fail");
});

test("shellChanges finds the files a command deletes, moves, copies or patches", () => {
  expect(shellChanges("git rm -r --cached a.js b/c.js")).toEqual(["a.js", "b/c.js"]);
  expect(shellChanges("rm -rf -- -x.sh y.sh")).toEqual(["-x.sh", "y.sh"]);
  expect(shellChanges("mv a.sh dir")).toEqual(["a.sh", "dir", "dir/a.sh"]);
  expect(shellChanges("cp a.sh b.sh c/")).toEqual(["c/", "c/a.sh", "c/b.sh"]);
  expect(shellChanges("git -C sub mv a b")).toEqual(["sub/a", "sub/b", "sub/b/a"]);
  expect(shellChanges("git checkout -- a.js && git checkout main")).toEqual(["a.js"]);
  expect(shellChanges("cat <<'EOF' | git apply\n--- a/x.js\n+++ b/x.js\nEOF")).toEqual(["x.js"]);
  expect(shellChanges("git apply --check <<<'+++ b/x.js'")).toEqual([]);
  expect(shellChanges("git apply --stat --apply <<<'+++ b/x.js'")).toEqual(["x.js"]);
  // Scratch paths, paths built at run time and patch files on disk are not counted.
  expect(shellChanges('rm -rf /tmp/x "$DIR/y" && git apply fix.patch && git checkout main')).toEqual([]);
});

describe("review-skipped", () => {
  const checkouts = [
    { repo: "github.com/o/app", root: "/w/app" },
    { repo: "github.com/o/app-docs", root: "/w/app/docs" },
    { repo: "github.com/o/lib", root: "/w/lib" },
    { repo: "github.com/o/home", root: join(homedir(), "no-such-checkout-x1") },
  ].sort((a, b) => b.root.length - a.root.length);
  const matcher = reviewMatcher({ trivial: ["**/Cargo.lock", "**/*.png"] });
  const detect = (calls, options, ignored = () => false) => reviewSkipped(actions(calls, options), { matcher, checkouts, ignored });
  const edit = (file, extra) => call("Edit", { file_path: file, old_string: "a", new_string: "b" }, extra);
  const review = (extra) => call("Skill", { skill: "code-review", args: "xhigh origin/main...abc1234" }, extra);
  const typed = (name) => ({ name, args: "xhigh", at: call("Noop", {}).at });

  test("fails a push of any non-trivial edit with no review, docs and tests too", () => {
    const calls = [edit("/w/app/hooks/pre.sh"), edit("/w/app/src/main.rs"), edit("/w/app/README.md"), edit("/w/app/tests/main.test.js"), edit("/w/app/Cargo.lock"), bash("git push origin feature")];
    const result = detect(calls);
    expect(result.verdict).toBe("fail");
    expect(result.hits[0].files).toEqual(["o/app:hooks/pre.sh", "o/app:src/main.rs", "o/app:README.md", "o/app:tests/main.test.js"]);
    expect(result.hits[0].evidence).toContain("git push origin feature");
  });

  test("passes a review after the first edit, with fixes after it", () => {
    expect(detect([edit("/w/app/hooks/pre.sh"), review({ agent: "agent-r1" }), edit("/w/app/hooks/pre.sh"), bash("git push -u origin feature")]).verdict).toBe("pass");
    // A review typed as a slash command, or a plugin's code-review skill, counts too.
    for (const name of ["/code-review", "/review", "/tools:code-review"]) {
      const [first, command] = [edit("/w/app/hooks/pre.sh"), typed(name)];
      expect(detect([first, bash("git push")], { commands: [command] }).verdict, name).toBe("pass");
    }
    expect(detect([edit("/w/app/hooks/pre.sh"), call("Skill", { skill: "tools:code-review" }), bash("git push")]).verdict).toBe("pass");
    // So does the `reviewer` agent the Review rule has the session start; another agent does not.
    const reviewer = (type, extra) => call("Agent", { subagent_type: type, prompt: "origin/main...abc1234", run_in_background: true }, extra);
    expect(detect([edit("/w/app/hooks/pre.sh"), reviewer("reviewer"), bash("git push")]).verdict).toBe("pass");
    expect(detect([edit("/w/app/hooks/pre.sh"), reviewer("explorer"), bash("git push")]).verdict).toBe("fail");
    expect(detect([edit("/w/app/hooks/pre.sh"), reviewer("reviewer", { ok: false }), bash("git push")]).verdict).toBe("fail");
  });

  test("a review before the edits, or one refused, does not count", () => {
    expect(detect([review(), edit("/w/app/hooks/pre.sh"), bash("git push")]).verdict).toBe("fail");
    expect(detect([edit("/w/app/hooks/pre.sh"), review({ ok: false }), bash("git push")]).verdict).toBe("fail");
  });

  test("each push settles the edits before it; later fixes to reviewed files need no review", () => {
    const result = detect([edit("/w/app/hooks/a.sh"), review(), bash("git push"), edit("/w/app/hooks/b.sh"), bash("gh pr merge 12 --merge --auto")]);
    expect(result.verdict).toBe("fail");
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].files).toEqual(["o/app:hooks/b.sh"]);
    expect(detect([edit("/w/app/hooks/a.sh"), review(), bash("git push"), edit("/w/app/hooks/a.sh"), bash("git push")]).verdict).toBe("pass");
  });

  test("a push settles only its own repository's edits when its folder is known", () => {
    const calls = [edit("/w/app/hooks/a.sh"), edit("/w/lib/hooks/b.sh"), bash("git -C /w/lib push"), review(), bash("git push", { cwd: "/w/app" })];
    const result = detect(calls);
    expect(result.hits.map((found) => found.files)).toEqual([["o/lib:hooks/b.sh"]]);
    // From the call's folder; a push from an unknown folder settles every repository.
    expect(detect([edit("/w/app/hooks/a.sh"), bash("git push", { cwd: "/w/lib" }), review(), bash("git push", { cwd: "/w/app" })]).verdict).toBe("pass");
    expect(detect([edit("/w/app/hooks/a.sh"), bash("cd sub && git push", { cwd: "/w/lib" })]).verdict).toBe("fail");
    expect(detect([edit("/w/app/hooks/a.sh"), bash("git push", { cwd: "/elsewhere" })]).verdict).toBe("na");
  });

  test("only real pushes and merges count", () => {
    for (const command of ['rg -n "gh pr merge" /w/app', 'git commit -m "then gh pr merge it"', "git push origin --delete old", "git push origin :old", "git push --tags", "git push -n"])
      expect(detect([edit("/w/app/hooks/a.sh"), bash(command), review(), bash("git push")]).verdict, command).toBe("pass");
    // A failed command whose push came before the part that failed still pushed.
    expect(detect([edit("/w/app/hooks/a.sh"), bash("git push -u origin f && gh pr create --fill", { ok: false })]).verdict).toBe("fail");
    expect(detect([edit("/w/app/hooks/a.sh"), bash("git push", { ok: false })]).verdict).toBe("na");
  });

  test("finds edits in worktrees, subagents and Bash commands", () => {
    for (const file of ["/w/app/.claude/worktrees/fix/.github/workflows/ci.yml", "/u/.t3/worktrees/app/t3-1a2b/src/auth.rs", "/u/.t3/worktrees/app/t3-1/.claude/worktrees/a/src/auth.rs"])
      expect(detect([edit(file, { agent: "agent-w1" }), bash("git push")]).verdict, file).toBe("fail");
    expect(detect([bash("sed -i '' 's/a/b/' /w/app/hooks/pre.sh"), bash("git push")]).verdict).toBe("fail");
    // A failed command made its edits before the part that failed.
    expect(detect([bash("sed -i '' 's/a/b/' /w/app/hooks/pre.sh && bun test", { ok: false }), bash("git push")]).verdict).toBe("fail");
    // Home-relative paths, and relative ones from the call's folder unless it changed.
    expect(detect([bash("sed -i '' 's/a/b/' ~/no-such-checkout-x1/hooks/x.sh"), bash("git push")]).verdict).toBe("fail");
    expect(detect([bash("sed -i '' 's/a/b/' hooks/x.sh", { cwd: "/w/app" }), bash("git push")]).verdict).toBe("fail");
    expect(detect([bash("cd /tmp && sed -i '' 's/a/b/' hooks/x.sh", { cwd: "/w/app" }), bash("git push")]).verdict).toBe("na");
    // A file in a nested checkout belongs to that checkout's repository.
    expect(detect([edit("/w/app/docs/src/auth.rs"), bash("git push")]).hits[0].files).toEqual(["o/app-docs:src/auth.rs"]);
  });

  test("counts deletes, moves, copies and patches of files that need a review as edits", () => {
    const patch = "git apply <<'EOF'\ndiff --git a/hooks/pre.sh b/hooks/pre.sh\n--- a/hooks/pre.sh\n+++ b/hooks/pre.sh\n@@ -1 +1 @@\n-a\n+b\nEOF";
    const commands = ["git rm hooks/pre.sh", "rm -f /w/app/hooks/pre.sh", "mv hooks/pre.sh hooks/post.sh", "cp /tmp/x.sh /w/app/hooks/", "git checkout HEAD -- hooks/pre.sh", patch];
    for (const command of commands) {
      const result = detect([bash(command, { cwd: "/w/app" }), bash("git push", { cwd: "/w/app" })]);
      expect(result.verdict, command).toBe("fail");
      // A copy into a folder names the folder too.
      expect(result.hits[0].files.every((file) => /^o\/app:hooks(\/|$)/.test(file)), command).toBe(true);
      // A review after the change and before the push passes: the `reviewer` agent, or /code-review.
      const reviewer = () => call("Agent", { subagent_type: "reviewer", prompt: "origin/main...abc1234", run_in_background: true });
      expect(detect([bash(command, { cwd: "/w/app" }), reviewer(), bash("git push", { cwd: "/w/app" })]).verdict, command).toBe("pass");
      expect(detect([bash(command, { cwd: "/w/app" }), review(), bash("git push", { cwd: "/w/app" })]).verdict, command).toBe("pass");
    }
    // Moving a file to a trivial name still changes it; deleting only trivial files does not.
    expect(detect([bash("git mv hooks/pre.sh old.png", { cwd: "/w/app" }), bash("git push", { cwd: "/w/app" })]).verdict).toBe("fail");
    expect(detect([bash("rm -f Cargo.lock logo.png", { cwd: "/w/app" }), bash("git push", { cwd: "/w/app" })]).verdict).toBe("na");
  });

  test("is na without a pushed edit that needs a review", () => {
    expect(detect([edit("/w/app/Cargo.lock"), edit("/w/app/assets/logo.png"), bash("git push")]).verdict).toBe("na");
    expect(detect([edit("/w/app/hooks/pre.sh")]).verdict).toBe("na");
    expect(detect([edit("/elsewhere/hooks/pre.sh"), bash("git push")]).verdict).toBe("na");
    expect(detect([edit("/w/app/hooks/pre.sh"), bash("git push --dry-run origin feature")]).verdict).toBe("na");
    expect(detect([edit("/w/app/hooks/pre.sh", { ok: false }), bash("git push")]).verdict).toBe("na");
    // Files git ignores are never pushed.
    expect(detect([edit("/w/app/hooks/local.sh"), bash("git push")], {}, ({ path }) => path === "hooks/local.sh").verdict).toBe("na");
  });

  test("every file needs a review except the trivial kinds, in every repository", () => {
    const check = reviewMatcher(loadReviewScope());
    for (const repo of ["github.com/syz51/papers", "github.com/syz51/claimcheck", "github.com/syz51/prov", "github.com/syz51/ireval", "github.com/syz51/agent-board", "github.com/syz51/research-factory", "github.com/o/unknown"]) {
      for (const path of ["src/lib.rs", "Cargo.toml", "README.md", "docs/guide.md", "tests/cli.rs", "package.json", ".github/workflows/ci.yml", "assets/icon.svg"]) expect(check({ repo, path }), `${repo} ${path}`).toBe(true);
      for (const path of ["Cargo.lock", "web/bun.lock", "uv.lock", "tests/snapshots/cli__help.snap", "src/__snapshots__/a.test.js.snap", "docs/shot.png"]) expect(check({ repo, path }), `${repo} ${path}`).toBe(false);
    }
  });

  // The rule covers every repository the user works in, not only those the board lists:
  // a checkout the board does not know maps through git and its origin remote.
  test("flags an unreviewed push in syz51/papers, a repository review-scope.toml does not name", () => {
    expect(readFileSync(REVIEW_SCOPE_FILE, "utf8")).not.toContain("papers");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "review-papers-")));
    cleanup.push(dir);
    const papers = join(dir, "papers");
    for (const args of [["init", "-q", papers], ["-C", papers, "remote", "add", "origin", "git@github.com:syz51/papers.git"]]) expect(Bun.spawnSync(["git", ...args]).exitCode).toBe(0);
    mkdirSync(join(papers, "src"));
    const real = { matcher: reviewMatcher(loadReviewScope()), checkouts: [], git: gitCheckout, ignored: gitIgnored };
    const run = (calls) => reviewSkipped(actions(calls), real);
    const result = run([edit(join(papers, "src", "lib.rs")), edit(join(papers, "Cargo.lock")), bash("git push -u origin feature", { cwd: papers })]);
    expect(result.verdict).toBe("fail");
    expect(result.hits[0].files).toEqual(["syz51/papers:src/lib.rs"]);
    expect(run([edit(join(papers, "src", "lib.rs")), call("Agent", { subagent_type: "reviewer", prompt: "origin/main...abc1234", run_in_background: true }), bash("git push", { cwd: papers })]).verdict).toBe("pass");
    // A lockfile-only change may skip review.
    expect(run([edit(join(papers, "Cargo.lock")), bash("git push", { cwd: papers })]).verdict).toBe("na");
    // The board's own checkout of papers maps the same way.
    const board = { ...real, checkouts: [{ repo: "github.com/syz51/papers", root: papers }], git: () => null };
    expect(reviewSkipped(actions([edit(join(papers, "src", "lib.rs")), bash("git push", { cwd: papers })]), board).hits[0].files).toEqual(["syz51/papers:src/lib.rs"]);

    // Outside any checkout git finds nothing; a checkout without a remote is named by its root.
    expect(gitCheckout(join(dir, "loose", "x.rs"))).toBeNull();
    // A path that names a file as a folder looks from the file's folder.
    writeFileSync(join(papers, "notes.txt"), "");
    expect(gitCheckout(join(papers, "notes.txt", "x"))).toEqual({ repo: "github.com/syz51/papers", root: papers, path: "notes.txt/x" });
    const local = join(dir, "local");
    expect(Bun.spawnSync(["git", "init", "-q", local]).exitCode).toBe(0);
    expect(gitCheckout(join(local, "new", "x.rs"))).toEqual({ repo: local, root: local, path: "new/x.rs" });
  });

  test("repoName names a remote as the board does", () => {
    for (const url of ["git@github.com:syz51/papers.git", "https://github.com/syz51/papers.git", "https://x:token@github.com/Syz51/Papers", "ssh://git@github.com/syz51/papers/"]) expect(repoName(url), url).toBe("github.com/syz51/papers");
    expect(repoName("/srv/git/app")).toBe("/srv/git/app");
  });

  test("locate maps checkouts and both kinds of worktree, and nothing else", () => {
    const app = { repo: "github.com/o/app", root: "/w/app" };
    const docs = { repo: "github.com/o/app-docs", root: "/w/app/docs" };
    expect(locate("/w/app/src/main.rs", checkouts)).toEqual({ ...app, path: "src/main.rs" });
    expect(locate("/w/app/docs/index.md", checkouts)).toEqual({ ...docs, path: "index.md" });
    expect(locate("/w/app/.claude/worktrees/x/src/main.rs", checkouts)).toEqual({ ...app, path: "src/main.rs" });
    expect(locate("/u/.t3/worktrees/docs/t3-1/index.md", checkouts)).toEqual({ ...docs, path: "index.md" });
    expect(locate("/u/.t3/worktrees/app/t3-1/.claude/worktrees/a/src/main.rs", checkouts)).toEqual({ ...app, path: "src/main.rs" });
    expect(locate("/w/application/x", checkouts)).toBeNull();
    expect(locate("/u/.t3/worktrees/other/t3-1/x", checkouts)).toBeNull();
  });

  test("resolves symbolic links, and asks git which files it ignores", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "review-skipped-")));
    cleanup.push(dir);
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "claude", "hooks"), { recursive: true });
    symlinkSync(join(repo, "claude"), join(dir, "link"));
    expect(realFile(join(dir, "link", "hooks", "new", "x.sh"))).toBe(join(repo, "claude", "hooks", "new", "x.sh"));
    expect(realFile("/w/app/x")).toBe("/w/app/x");

    expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
    writeFileSync(join(repo, ".gitignore"), "/claude/hooks/local.sh\n");
    expect(gitIgnored({ root: repo, path: "claude/hooks/local.sh" })).toBe(true);
    expect(gitIgnored({ root: repo, path: "claude/hooks/guard.sh" })).toBe(false);
    expect(gitIgnored({ root: join(dir, "gone"), path: "x" })).toBe(false);

    const own = [{ repo: "github.com/o/repo", root: repo }];
    const result = reviewSkipped(actions([edit(join(dir, "link", "hooks", "guard.sh")), edit(join(dir, "link", "hooks", "local.sh")), bash("git push")]), { matcher, checkouts: own, ignored: gitIgnored });
    expect(result.hits[0].files).toEqual(["o/repo:claude/hooks/guard.sh"]);
  });

  test("reads the board's checkouts and checks the lists", () => {
    const home = mkdtempSync(join(tmpdir(), "board-home-"));
    cleanup.push(home);
    writeFileSync(join(home, "config.toml"), 'server = "https://board"\n\n[projects]\n"github.com/O/App" = "/w/app/"\n"github.com/o/app-docs" = "/w/app/docs"\n');
    expect(boardCheckouts({ BOARD_HOME: home })).toEqual([
      { repo: "github.com/o/app-docs", root: "/w/app/docs" },
      { repo: "github.com/o/app", root: "/w/app" },
    ]);
    expect(boardCheckouts({ BOARD_HOME: join(home, "missing") })).toEqual([]);

    expect(loadReviewScope().trivial).toContain("**/Cargo.lock");
    // The list is by file kind: a repository entry, or the old path lists, are refused.
    writeFileSync(join(home, "repo.toml"), 'trivial = ["a"]\n[repos."x"]\ntrivial = ["b"]\n');
    expect(() => loadReviewScope(join(home, "repo.toml"))).toThrow("unknown keys repos; the list is by file kind, never by repository");
    writeFileSync(join(home, "bad.toml"), 'trivial = "a"\n');
    expect(() => loadReviewScope(join(home, "bad.toml"))).toThrow("trivial must be a list of globs");
  });
});

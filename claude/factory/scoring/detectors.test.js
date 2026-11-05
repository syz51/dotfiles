import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transcript, writeProjects } from "../lib/testing/transcripts.js";
import { loadSessions } from "../lib/transcripts.js";
import { aiAttribution, forcePush, forcePushProblem, gitPushes, packageRunner, runDetectors, simpleCommands, ultraEffort } from "./detectors.js";

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
    "uv run pytest -q",
    "uv run --no-project python -B script.py",
    "UV_OFFLINE=1 uv run python3 x.py",
    "grep -r npm docs",
    "echo 'python3 is not run here'",
    "for c in \"npm test\" \"pip install x\"; do echo \"$c\"; done",
    "tuios list-options 2>&1 | grep -iE 'hook|custom|pip' | head -40",
    "cat > t.sh <<'EOF'\npython3 x.py\nEOF\nbun t.sh",
  ])("passes %p", (command) => {
    expect(packageRunner(actions([bash(command)])).verdict).toBe("pass");
  });

  test("a matching lockfile in the session's folder makes the project's runner fine", () => {
    const cwd = mkdtempSync(join(tmpdir(), "claude-factory-lock-"));
    cleanup.push(cwd);
    writeFileSync(join(cwd, "pnpm-lock.yaml"), "");
    expect(packageRunner(actions([bash("pnpm test")], { cwd })).verdict).toBe("pass");
    expect(packageRunner(actions([bash("npm test")], { cwd })).verdict).toBe("fail");
    writeFileSync(join(cwd, "package-lock.json"), "{}");
    expect(packageRunner(actions([bash("npm test"), bash("npx tsc")], { cwd })).verdict).toBe("pass");
    // A lockfile cannot excuse Python outside uv.
    expect(packageRunner(actions([bash("pip install x")], { cwd })).verdict).toBe("fail");
    // The folder no longer existing leaves the command unexcused.
    expect(packageRunner(actions([bash("pnpm test")], { cwd: join(cwd, "gone") })).verdict).toBe("fail");
  });

  test("is na without any Bash call", () => {
    expect(packageRunner(actions([call("Read", { file_path: "/a" })])).verdict).toBe("na");
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
  const agent = new Transcript({ sessionId: main.sessionId }).tool("Bash", { command: "git push --force origin feature" }, "ok").tool("Bash", { command: "npm test" }, "ok");
  const root = writeProjects([{ transcript: main, subagents: [{ id: "agent-a1", meta: { agentType: "worker" }, transcript: agent }] }]);
  cleanup.push(root);
  const [session] = loadSessions({ root });
  const results = runDetectors(session);
  expect(Object.fromEntries(Object.entries(results).map(([id, result]) => [id, result.verdict]))).toEqual({
    "package-runner": "fail",
    "ai-attribution": "fail",
    "force-push": "fail",
    "ultra-effort": "pass",
  });
  expect(results["force-push"].hits[0].agent).toBe("agent-a1");
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

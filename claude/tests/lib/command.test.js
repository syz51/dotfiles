import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkInvocation, checkRun, commandLists, mayInvoke, successfulCheck } from "./command.js";
import { runProcess } from "./process.js";

const uv = { tool: "uv", script: "check.py" };
const bunCheck = { tool: "bun", script: "check.js" };
const npm = { tool: "npm", script: "check.js" };
const fixture = "/work/fixture";

describe("literal grammar", () => {
  test("splits && lists and joins quoted words", () => {
    expect(commandLists("cd 'a b' && uv run python check.py")).toEqual([["cd", "a b"], ["uv", "run", "python", "check.py"]]);
    expect(commandLists("echo a'b'\"c\"")).toEqual([["echo", "abc"]]);
  });

  test("unwraps one standard shell wrapper, not two", () => {
    expect(commandLists("bash -lc 'uv run check.py'")).toEqual([["uv", "run", "check.py"]]);
    expect(commandLists("sh -c \"bash -c 'uv run check.py'\"")).toBeNull();
    expect(commandLists("sh -x 'uv run check.py'")).toBeNull();
  });

  test("accepts 2>&1 only at the end of a list", () => {
    expect(commandLists("uv run check.py 2>&1")).toEqual([["uv", "run", "check.py"]]);
    expect(commandLists("uv run check.py 2>&1 && pwd")).toEqual([["uv", "run", "check.py"], ["pwd"]]);
    expect(commandLists("uv 2>&1 run check.py")).toBeNull();
  });

  test("rejects operators, expansions and redirections that could mask a failure", () => {
    for (const command of [
      "uv run check.py || true", "uv run check.py; true", "uv run check.py | tail", "uv run $(echo check.py)",
      "uv run `echo check.py`", 'uv run "$SCRIPT"', "uv run check.py &", "uv run ~/check.py",
      "uv run check.py # comment", "uv run 'check.py", "uv run check.py\nuv run check.py", "&& uv run check.py",
      "printf x > && uv run check.py", "printf x >", "printf x >&2 && uv run check.py", "printf x >| calc.py",
      "printf x > > calc.py", "printf x > $FILE", "uv run check.py < input.txt",
    ])
      expect(commandLists(command), command).toBeNull();
  });

  test("reads output redirections to a literal file and marks their part", () => {
    const lists = commandLists("printf 'def total(v):\\n    return sum(v)\\n' > calc.py && uv run check.py");
    expect(lists).toEqual([["printf", "def total(v):\\n    return sum(v)\\n"], ["uv", "run", "check.py"]]);
    expect(lists.map((words) => !!words.redirected)).toEqual([true, false]);
    const appended = commandLists("printf x>>'notes.txt' && uv run check.py > out");
    expect(appended).toEqual([["printf", "x"], ["uv", "run", "check.py"]]);
    expect(appended.map((words) => !!words.redirected)).toEqual([true, true]);
  });
});

describe("check invocations", () => {
  test("uv runs the script, with offline-only flags and environment", () => {
    for (const words of [
      ["uv", "run", "check.py"], ["uv", "run", "python", "check.py"], ["uv", "run", "python3", "-B", "./check.py"],
      ["uv", "run", "--no-project", "--offline", "python", "check.py"], ["UV_OFFLINE=1", "uv", "run", "check.py"],
    ])
      expect(checkInvocation(words, uv), words.join(" ")).toBe(true);
    for (const words of [
      ["python", "check.py"], ["uv", "run", "--with", "x", "check.py"], ["uv", "run", "check.py", "extra"],
      ["EVIL=1", "uv", "run", "check.py"], ["uv", "run", "other.py"], ["uvx", "check.py"],
    ])
      expect(checkInvocation(words, uv), words.join(" ")).toBe(false);
  });

  test("bun and npm run their check", () => {
    expect(checkInvocation(["bun", "check.js"], bunCheck)).toBe(true);
    expect(checkInvocation(["bun", "run", "./check.js"], bunCheck)).toBe(true);
    expect(checkInvocation(["node", "check.js"], bunCheck)).toBe(false);
    for (const words of [["npm", "test"], ["npm", "t"], ["npm", "run", "test"]]) expect(checkInvocation(words, npm)).toBe(true);
    expect(checkInvocation(["bun", "run", "test"], npm)).toBe(false);
  });
});

describe("binding a check to the fixture directory", () => {
  test("uses the recorded cwd, moved by literal cd", () => {
    expect(checkRun("uv run python check.py", uv, { cwd: fixture, fixture })).toBe(true);
    expect(checkRun("cd fixture && uv run python check.py", uv, { cwd: "/work", fixture })).toBe(true);
    expect(checkRun(`cd ${fixture} && pwd && ls -la && uv run check.py 2>&1`, uv, { cwd: "/elsewhere", fixture })).toBe(true);
    expect(checkRun("cd .. && uv run check.py", uv, { cwd: fixture, fixture })).toBe(false);
    expect(checkRun("uv run check.py", uv, { cwd: "/work/decoy", fixture })).toBe(false);
    expect(checkRun("uv run check.py", uv, { cwd: undefined, fixture })).toBe(false);
    expect(checkRun("cd && uv run check.py", uv, { cwd: fixture, fixture })).toBe(false);
  });

  test("printed checks, masked failures and checks that are not last prove nothing", () => {
    for (const command of [
      "echo uv run python check.py", "echo fixture-check:ok", "uv run python check.py || true",
      "python3 check.py && uv run --version", "cat check.py", "uv run check.py; true", "uv run check.py\necho done",
      "uv run check.py | tail -3", "uv run check.py 2>&1 | tail -3",
      "uv run check.py > out.txt", "uv run check.py > /dev/null && echo fixture-check:ok",
    ])
      expect(checkRun(command, uv, { cwd: fixture, fixture }), command).toBe(false);
  });

  test("the last segment of a script decides; earlier ones may edit files", () => {
    for (const command of [
      "sed -i '' 's/sum(values) + 1/sum(values)/' calc.py && uv run python check.py",
      "cat check.py; sed -i '' 's/41/42/' calc.py; uv run check.py",
      "cat > calc.py <<'EOF'\ndef total(values):\n    return sum(values); print('x')\nEOF\nuv run check.py",
      `cd ${fixture}; ls; cat calc.py | head; uv run check.py`,
      "bash -lc 'cat calc.py; uv run check.py'",
      "sh -c \"bash -c 'ls'; uv run check.py\"",
      "rm -rf __pycache__ && uv run check.py",
      "printf 'def total(values):\\n    return sum(values)\\n' > calc.py && uv run check.py",
      "cat calc.py > /dev/null && uv run check.py 2>&1",
    ])
      expect(checkRun(command, uv, { cwd: fixture, fixture }), command).toBe(true);
    expect(checkRun("printf 'export const answer = 42;\\n' > calc.js && npm test", npm, { cwd: fixture, fixture })).toBe(true);
  });

  test("an earlier segment that may move the shell or redefine the check proves nothing", () => {
    for (const command of [
      "cd /elsewhere; uv run check.py", "cd ~/x; uv run check.py", "pushd /tmp; uv run check.py",
      "uv() { echo fixture-check:ok; }; uv run check.py", "alias uv=echo; uv run check.py",
      "PATH=/tmp/fake:$PATH; uv run check.py", "export PATH=/tmp/fake; uv run check.py", "PATH=/tmp/fake && uv run check.py",
      "source env.sh; uv run check.py", "cat <<'EOF'\nunterminated",
    ])
      expect(checkRun(command, uv, { cwd: fixture, fixture }), command).toBe(false);
    // From outside, a cd that may have failed leaves two possible directories.
    expect(checkRun("cd fixture; uv run check.py", uv, { cwd: "/work", fixture })).toBe(false);
    expect(checkRun("cd fixture && uv run check.py", uv, { cwd: "/work", fixture })).toBe(true);
  });

  test("a successful check needs zero exit and the success marker", () => {
    const run = { command: "uv run check.py", cwd: fixture, ok: true, output: "fixture-check:ok\n" };
    expect(successfulCheck([run], uv, fixture)).toBe(true);
    expect(successfulCheck([{ ...run, ok: false }], uv, fixture)).toBe(false);
    expect(successfulCheck([{ ...run, output: "prefix fixture-check:ok" }], uv, fixture)).toBe(false);
    expect(successfulCheck([{ ...run, command: "echo fixture-check:ok" }], uv, fixture)).toBe(false);
  });

  test("real subprocesses: a masked failure cannot pass, a compound success can", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "command-test-")));
    try {
      writeFileSync(join(root, "check.js"), 'if (process.env.FAIL) throw new Error("fails"); console.log("fixture-check:ok");\n');
      const run = async (command, env = {}) => {
        const result = await runProcess(["sh", "-c", command], { cwd: root, env: { ...process.env, ...env } });
        return { command, cwd: root, ok: result.code === 0, output: result.stdout + result.stderr };
      };
      expect(successfulCheck([await run(`pwd && bun check.js`)], bunCheck, root)).toBe(true);
      // Exits zero and prints the marker, yet the check itself failed.
      const masked = await run(`bun check.js || echo fixture-check:ok`, { FAIL: "1" });
      expect(masked.ok).toBe(true);
      expect(successfulCheck([masked], bunCheck, root)).toBe(false);
      expect(successfulCheck([await run(`bun check.js`, { FAIL: "1" })], bunCheck, root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mayInvoke", () => {
  test("finds the program in readable commands", () => {
    expect(mayInvoke("bun check.js", "bun")).toBe(true);
    expect(mayInvoke("bunx tsc", "bun")).toBe(true);
    expect(mayInvoke("FOO=1 /usr/local/bin/bun test", "bun")).toBe(true);
    expect(mayInvoke("npm test && cat bun.lock", "bun")).toBe(false);
    expect(mayInvoke("uv run python check.py", "python")).toBe(false);
    expect(mayInvoke("python3 check.py", "python3")).toBe(true);
  });

  test("counts any command position in unreadable commands", () => {
    expect(mayInvoke("npm test | tail -5; bun check.js", "bun")).toBe(true);
    expect(mayInvoke("sh -c 'cd x; bun check.js'", "bun")).toBe(true);
    expect(mayInvoke("uv run python check.py 2>&1 | tail -5", "python")).toBe(false);
    expect(mayInvoke("grep -r bun . | head", "bun")).toBe(false);
    expect(mayInvoke("ls node_modules | head", "node")).toBe(false);
  });
});

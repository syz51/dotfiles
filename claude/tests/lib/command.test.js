import { describe, expect, test } from "bun:test";
import { commandLists, mayInvoke } from "./command.js";

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

describe("mayInvoke", () => {
  test("finds the program in readable commands", () => {
    expect(mayInvoke("bun check.js", "bun")).toBe(true);
    expect(mayInvoke("bunx tsc", "bun")).toBe(true);
    expect(mayInvoke("FOO=1 /usr/local/bin/bun test", "bun")).toBe(true);
    expect(mayInvoke("npm test && cat bun.lock", "bun")).toBe(false);
    expect(mayInvoke("uv run python check.py", "python")).toBe(false);
    expect(mayInvoke("python3 check.py", "python3")).toBe(true);
  });

  // The runtime rule of a live check, now that its output proves it passed: commands from
  // live runs that run the check through uv or bun, and the same checks run directly.
  test("tells a check through uv or bun from a direct run", () => {
    const viaUv = 'printf "x\\n" > calc.py && uv run check.py; echo "exit=$?"; find . -name __pycache__';
    for (const tool of ["python", "python3"]) expect(mayInvoke(viaUv, tool), tool).toBe(false);
    expect(mayInvoke('cd "$PWD" && python3 check.py', "python3")).toBe(true);
    const viaBun = `cd "$PWD" && sed -i '' 's/1)/0)/' calc.js && cat calc.js && bun check.js`;
    for (const tool of ["node", "npm"]) expect(mayInvoke(viaBun, tool), tool).toBe(false);
    expect(mayInvoke('cd "$PWD" && node check.js', "node")).toBe(true);
  });

  test("counts any command position in unreadable commands", () => {
    expect(mayInvoke("npm test | tail -5; bun check.js", "bun")).toBe(true);
    expect(mayInvoke("sh -c 'cd x; bun check.js'", "bun")).toBe(true);
    expect(mayInvoke("uv run python check.py 2>&1 | tail -5", "python")).toBe(false);
    expect(mayInvoke("grep -r bun . | head", "bun")).toBe(false);
    expect(mayInvoke("ls node_modules | head", "node")).toBe(false);
  });
});

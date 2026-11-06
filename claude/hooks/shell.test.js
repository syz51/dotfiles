import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { parseScript, visitCommands } from "./shell.js";

/** Every command `source` runs, with the directory it runs in. */
function commands(source, cwd = "/repo") {
  const seen = [];
  visitCommands(source, cwd, (words, dir) => {
    seen.push([words.join(" "), dir]);
  });
  return seen;
}

test("parseScript splits operators, drops redirections, and keeps shell inputs", () => {
  const { commands: parsed, substitutions } = parseScript('a \'b c\' && d >out 2>&1; e | f <<< "x" && echo "$(g h)"');
  expect(parsed.map((command) => command.argv)).toEqual([["a", "b c"], ["d"], ["e"], ["f"], ["echo", "$(g h)"]]);
  expect(parsed.map((command) => command.next)).toEqual(["&&", ";", "|", "&&", undefined]);
  expect(parsed[3].inputs).toEqual(["x"]);
  expect(substitutions).toEqual(["g h"]);
});

test("cd changes the directory of later commands, and ~ is the home folder", () => {
  expect(commands("cd sub && make; cd ~ && ls")).toEqual([["make", "/repo/sub"], ["ls", homedir()]]);
  expect(commands("cd $X && make")).toEqual([["make", undefined]]);
});

test("wrappers are skipped, including combined options whose last letter takes a value", () => {
  expect(commands("sudo -iu me make")).toEqual([["make", "/repo"]]);
  expect(commands("sudo -u me -E make")).toEqual([["make", "/repo"]]);
  expect(commands("env -C sub FOO=1 make")).toEqual([["make", "/repo/sub"]]);
  expect(commands("coproc job { make; }")).toEqual([["make", "/repo"]]);
});

test("find -exec runs its command with the words kept intact", () => {
  expect(commands("find . -name '*.c' -exec cc -c {} \\; -print")).toEqual([["cc -c {}", "/repo"], ["find . -name *.c -exec cc -c {} ; -print", "/repo"]]);
  expect(commands("find . -exec sh -c 'make \"$1\"' _ {} +").map(([words]) => words)).toContain("make $1");
});

test("text printed into a shell runs, and text printed anywhere else does not", () => {
  expect(commands("echo 'make all' | sh").map(([words]) => words)).toEqual(["make all", "echo make all", "sh"]);
  expect(commands("echo 'make all' | grep make").map(([words]) => words)).toEqual(["echo make all", "grep make"]);
});

test("ssh runs its command remotely, in an unknown directory", () => {
  expect(commands("ssh -p 22 -o BatchMode=yes host 'cd app && make'")).toEqual([["make", undefined]]);
  expect(commands("ssh -tt host make test")).toEqual([["make test", undefined]]);
  expect(commands("ssh host <<'EOF'\nmake\nEOF")).toEqual([["make", undefined]]);
  expect(commands("ssh host")).toEqual([]);
});

test("a script nested too deeply returns tooDeep, or nothing by default", () => {
  let source = "make";
  for (let i = 0; i < 10; i++) source = `bash -c ${JSON.stringify(source)}`;
  const blockMake = (words) => (words[0] === "make" ? "blocked" : undefined);
  expect(visitCommands(source, "/repo", blockMake)).toBeUndefined();
  expect(visitCommands(source, "/repo", blockMake, "too deep")).toBe("too deep");
  expect(visitCommands("bash -c make", "/repo", blockMake)).toBe("blocked");
});

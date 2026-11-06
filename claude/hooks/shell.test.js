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

test("parseScript counts subshells, and the operator after `)` ends the command it closed", () => {
  const { commands: parsed } = parseScript("(cd x; (a)) | b; f() { c; }");
  expect(parsed.map(({ argv, opens, closes, next }) => [argv.join(" "), opens, closes, next])).toEqual([
    ["cd x", 1, 0, ";"], ["a", 1, 2, "|"], ["b", 0, 0, ";"], ["f", 0, 0, "("], ["{ c", 0, 0, ";"], ["}", 0, 0, undefined],
  ]);
});

test("cd changes the directory of later commands, and ~ is the home folder", () => {
  expect(commands("cd sub && make; cd ~ && ls")).toEqual([["make", "/repo/sub"], ["ls", homedir()]]);
  expect(commands("cd $X && make")).toEqual([["make", undefined]]);
});

test("wrappers are skipped, reading options as getopt does", () => {
  expect(commands("sudo -iu me make")).toEqual([["make", "/repo"]]);
  expect(commands("sudo -u me -E make")).toEqual([["make", "/repo"]]);
  // The first letter that takes a value takes the rest of the word, whatever it ends in.
  expect(commands("sudo -uubuntu make")).toEqual([["make", "/repo"]]);
  expect(commands("sudo -uhugh make")).toEqual([["make", "/repo"]]);
  expect(commands("xargs -IFILE make FILE")).toEqual([["make FILE", "/repo"]]);
  expect(commands("env -uTMP make")).toEqual([["make", "/repo"]]);
  expect(commands("timeout --signal=KILL 5 make")).toEqual([["make", "/repo"]]);
  expect(commands("sudo -- make")).toEqual([["make", "/repo"]]);
  expect(commands("env - make")).toEqual([["make", "/repo"]]);
  expect(commands("env -C sub FOO=1 make")).toEqual([["make", "/repo/sub"]]);
  expect(commands("env -Csub make")).toEqual([["make", "/repo/sub"]]);
  expect(commands("env -S 'make all'")).toEqual([["make all", "/repo"]]);
  expect(commands("env -Smake")).toEqual([["make", "/repo"]]);
  expect(commands("coproc job { make; }")).toEqual([["make", "/repo"]]);
});

test("find -exec runs its command with the words kept intact", () => {
  expect(commands("find . -name '*.c' -exec cc -c {} \\; -print")).toEqual([["cc -c {}", "/repo"], ["find . -name *.c -exec cc -c {} ; -print", "/repo"]]);
  expect(commands("find . -exec sh -c 'make \"$1\"' _ {} +").map(([words]) => words)).toContain("make $1");
  expect(commands("find . -ok make {} \\;")[0]).toEqual(["make {}", "/repo"]);
});

test("find -execdir and -okdir run in each match's directory, which is unknown here", () => {
  expect(commands("find /other -execdir make \\;")[0]).toEqual(["make", undefined]);
  expect(commands("find /other -okdir make {} +")[0]).toEqual(["make {}", undefined]);
});

test("fish runs its --command and --init-command scripts", () => {
  expect(commands("fish --command 'make a'")).toContainEqual(["make a", "/repo"]);
  expect(commands("fish --command='make b'")).toContainEqual(["make b", "/repo"]);
  expect(commands("fish -C 'make c' -c 'make d'").map(([words]) => words)).toEqual(["make c", "make d", "fish -C make c -c make d"]);
  expect(commands("fish --init-command=x <<< 'make e'")).toContainEqual(["make e", "/repo"]);
  // -C is noclobber, not a value, for other shells.
  expect(commands("bash -C <<< 'make f'")).toContainEqual(["make f", "/repo"]);
  expect(commands("fish --command make <<< 'make g'").map(([words]) => words)).not.toContain("make g");
});

test("text printed into a shell runs, and text printed anywhere else does not", () => {
  expect(commands("echo 'make all' | sh").map(([words]) => words)).toEqual(["make all", "echo make all", "sh"]);
  expect(commands("echo 'make all' | grep make").map(([words]) => words)).toEqual(["echo make all", "grep make"]);
});

test("text printed inside a group or subshell piped into a shell runs", () => {
  const ran = (source) => commands(source).map(([words]) => words);
  expect(ran("{ echo 'make a'; } | sh")).toContain("make a");
  expect(ran("(echo 'make b') | sh")).toContain("make b");
  expect(ran("(echo 'make c'; echo 'make d';) | bash")).toEqual(expect.arrayContaining(["make c", "make d"]));
  expect(ran("{ cd x; { echo 'make e'; }; } | sh")).toContain("make e");
  expect(ran("(echo 'make f') | grep make; echo 'make g'; sh")).not.toContain("make f");
  expect(ran("(echo 'make f') | grep make; echo 'make g'; sh")).not.toContain("make g");
});

test("ssh runs its command remotely, in an unknown directory", () => {
  expect(commands("ssh -p 22 -o BatchMode=yes host 'cd app && make'")).toEqual([["make", undefined]]);
  expect(commands("ssh -tt host make test")).toEqual([["make test", undefined]]);
  expect(commands("ssh host <<'EOF'\nmake\nEOF")).toEqual([["make", undefined]]);
  expect(commands("ssh host")).toEqual([]);
});

test("ssh reads options as getopt does, before and after the host", () => {
  expect(commands("ssh -lme host make")).toEqual([["make", undefined]]);
  expect(commands("ssh -lpi host make")).toEqual([["make", undefined]]);
  expect(commands("ssh -A -lme host make")).toEqual([["make", undefined]]);
  expect(commands("ssh host -t make")).toEqual([["make", undefined]]);
  expect(commands("ssh host -p 22 -o BatchMode=yes make")).toEqual([["make", undefined]]);
  expect(commands("ssh host -- make -t")).toEqual([["make -t", undefined]]);
  expect(commands("ssh -- host -t make")).toEqual([["-t make", undefined]]);
});

test("ssh feeds its input to a remote shell that reads standard input anywhere in its command", () => {
  expect(commands("ssh host 'cd app && bash -s' <<'EOF'\nmake\nEOF")).toContainEqual(["make", undefined]);
  expect(commands("ssh host 'cd app; exec bash' <<< make")).toContainEqual(["make", undefined]);
  expect(commands("echo make | ssh -lme host")).toContainEqual(["make", undefined]);
  expect(commands("ssh host 'cd app && ls' <<< make")).not.toContainEqual(["make", undefined]);
});

test("ssh options that run a command locally run it here", () => {
  expect(commands("ssh -o ProxyCommand='make proxy' host ls")).toEqual([["ls", undefined], ["make proxy", "/repo"]]);
  expect(commands("ssh -oProxyCommand=none host ls")).toEqual([["ls", undefined]]);
  expect(commands("ssh -o 'LocalCommand make local' -o PermitLocalCommand=yes host ls")).toContainEqual(["make local", "/repo"]);
  expect(commands("ssh host -o KnownHostsCommand='make known' ls")).toContainEqual(["make known", "/repo"]);
});

test("a script nested too deeply returns tooDeep, or nothing by default", () => {
  let source = "make";
  for (let i = 0; i < 10; i++) source = `bash -c ${JSON.stringify(source)}`;
  const blockMake = (words) => (words[0] === "make" ? "blocked" : undefined);
  expect(visitCommands(source, "/repo", blockMake)).toBeUndefined();
  expect(visitCommands(source, "/repo", blockMake, "too deep")).toBe("too deep");
  expect(visitCommands("bash -c make", "/repo", blockMake)).toBe("blocked");
});

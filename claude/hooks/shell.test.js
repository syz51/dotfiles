import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { ghSubcommands, parseScript, visitCommands } from "./shell.js";

/** Every command `source` runs, with the directory it runs in. */
function commands(source, cwd = "/repo") {
  const seen = [];
  visitCommands(source, cwd, (words, dir) => {
    seen.push([words.join(" "), dir]);
  });
  return seen;
}

test("parseScript splits operators, drops redirections, and keeps shell inputs", () => {
  const { commands: parsed } = parseScript('a \'b c\' && d >out 2>&1; e | f <<< "x" && echo "$(g h)"');
  expect(parsed.map((command) => command.argv)).toEqual([["a", "b c"], ["d"], ["e"], ["f"], ["echo", "$(g h)"]]);
  expect(parsed.map((command) => command.next)).toEqual(["&&", ";", "|", "&&", undefined]);
  expect(parsed[3].inputs).toEqual(["x"]);
  expect(parsed[4].substitutions).toEqual(["g h"]);
});

test("parseScript keeps an unquoted substitution in its word, with the words after it", () => {
  const { commands: parsed } = parseScript("a x$(b \")\" 'c)' $(d)) `e f` g; h");
  expect(parsed.map((command) => command.argv)).toEqual([["a", "x$(b \")\" 'c)' $(d))", "`e f`", "g"], ["h"]]);
  expect(parsed[0].substitutions).toEqual(["b \")\" 'c)' $(d)", "e f"]);
});

test("a case pattern's ) does not close a substitution", () => {
  const { commands: parsed } = parseScript("a $(case x in (y) b;; x) c;; esac) d");
  expect(parsed.map((command) => command.argv)).toEqual([["a", "$(case x in (y) b;; x) c;; esac)", "d"]]);
  expect(parsed[0].substitutions).toEqual(["case x in (y) b;; x) c;; esac"]);
});

test("an unquoted heredoc runs its substitutions; a quoted one does not", () => {
  expect(parseScript("cat <<EOF\n$(a) `b`\nEOF").commands[0].substitutions).toEqual(["a", "b"]);
  expect(parseScript("cat <<'EOF'\n$(a)\nEOF").commands[0].substitutions).toEqual([]);
});

test("a substitution in a redirection after ) belongs to the subshell, which stays in its pipeline", () => {
  const { commands: parsed } = parseScript("(a) 2>$(b) | c");
  expect(parsed.map(({ argv, substitutions, next }) => [argv.join(" "), substitutions, next])).toEqual([["a", ["b"], "|"], ["c", [], undefined]]);
});

test("text a substitution prints, echoed into a shell, runs", () => {
  const ran = (source) => commands(source).map(([words]) => words);
  expect(ran("echo $(echo make a) | sh")).toContain("make a");
  expect(ran("echo `printf 'make b'` | sh")).toContain("make b");
  expect(ran("printf '%s\\n' 'make c' | sh")).toContain("make c");
  expect(ran("echo $(echo make d) | grep make")).not.toContain("make d");
});

test("substitutions run in the directory of the command they belong to", () => {
  expect(commands("cd sub && make $(pwd) all")).toEqual([["pwd", "/repo/sub"], ["make $(pwd) all", "/repo/sub"]]);
  expect(commands("out=`make`; cd x; ls")).toEqual([["make", "/repo"], ["ls", "/repo/x"]]);
  expect(commands("x=$(cd sub && make); ls")).toEqual([["make", "/repo/sub"], ["ls", "/repo"]]);
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
  expect(commands("sudo -D sub make")).toEqual([["make", "/repo/sub"]]);
  expect(commands("sudo -u me --chdir /tmp make")).toEqual([["make", "/tmp"]]);
  expect(commands("sudo --chdir=sub make")).toEqual([["make", "/repo/sub"]]);
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

test("visit learns which commands run on the remote host over ssh", () => {
  const remote = (source) => {
    const seen = [];
    visitCommands(source, "/repo", (words, _dir, { remote: onRemote }) => {
      seen.push([words.join(" "), onRemote]);
    });
    return seen;
  };
  expect(remote("ssh host 'make; bash -c \"make test\"'; make")).toEqual([["make", true], ["make test", true], ["bash -c make test", true], ["make", false]]);
  expect(remote("echo make | ssh host")).toEqual([["make", true], ["echo make", false]]);
  expect(remote("ssh -o ProxyCommand='nc proxy' host ls")).toEqual([["ls", true], ["nc proxy", false]]);
  expect(remote("echo $(ssh host cat x) | make")).toEqual([["cat x", true], ["echo $(ssh host cat x)", false], ["make", false]]);
  expect(remote("ssh a ssh b make")).toEqual([["make", true]]);
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

test("a cd in a subshell, a background job or a pipeline does not move later commands", () => {
  expect(commands("(cd x && make); ls")).toEqual([["make", "/repo/x"], ["ls", "/repo"]]);
  expect(commands("(cd x; (cd y; make); ls); pwd")).toEqual([["make", "/repo/x/y"], ["ls", "/repo/x"], ["pwd", "/repo"]]);
  expect(commands("cd x | cat; ls")).toEqual([["cat", "/repo"], ["ls", "/repo"]]);
  expect(commands("cd x & ls")).toEqual([["ls", "/repo"]]);
  expect(commands("cd x |& cat; ls")).toEqual([["cat", "/repo"], ["ls", "/repo"]]);
  expect(commands("(cd x) | cat; ls")).toEqual([["cat", "/repo"], ["ls", "/repo"]]);
});

test("a cd in a pipeline's last part moves later commands, as zsh runs that part in the current shell", () => {
  expect(commands("ls | cd x; make")).toEqual([["ls", "/repo"], ["make", "/repo/x"]]);
  expect(commands("ls | cat | cd x && make")).toEqual([["ls", "/repo"], ["cat", "/repo"], ["make", "/repo/x"]]);
  expect(commands("ls | { cd x; }; make")).toEqual([["ls", "/repo"], ["make", "/repo/x"]]);
  expect(commands("ls | pushd x; make")).toEqual([["ls", "/repo"], ["make", "/repo/x"]]);
  // a ( … ) subshell still ends its cd, and a background pipeline runs in a subshell
  expect(commands("ls | (cd x); make")).toEqual([["ls", "/repo"], ["make", "/repo"]]);
  expect(commands("ls | cd x & make")).toEqual([["ls", "/repo"], ["make", "/repo"]]);
});

test("a { …; } group that a | or & follows runs in a subshell; one at a pipeline's end does not", () => {
  expect(commands("{ cd x; } | cat; make")).toEqual([["cat", "/repo"], ["make", "/repo"]]);
  expect(commands("{ cd x; make; } & ls")).toEqual([["make", "/repo/x"], ["ls", "/repo"]]);
  expect(commands("{ cd x; }; make")).toEqual([["make", "/repo/x"]]);
  expect(commands("cat | { cd x; }; make")).toEqual([["cat", "/repo"], ["make", "/repo/x"]]);
  // zsh backgrounds only the last pipeline of an and-or list, so this cd stays
  expect(commands("cd x && true & make")).toEqual([["true", "/repo/x"], ["make", "/repo/x"]]);
});

test("popd in a background job or an earlier pipeline part leaves the directory known", () => {
  expect(commands("popd | cat; make")).toEqual([["cat", "/repo"], ["make", "/repo"]]);
  expect(commands("popd & make")).toEqual([["make", "/repo"]]);
  expect(commands("popd; make")).toEqual([["make", undefined]]);
  expect(commands("ls | popd; make")).toEqual([["ls", "/repo"], ["make", undefined]]);
});

test("a substitution runs where its command starts, also in a piped ( … ) subshell", () => {
  expect(commands("(cd x; echo \"$(make)\") | cat")).toEqual([["make", "/repo/x"], ["echo $(make)", "/repo/x"], ["cat", "/repo"]]);
  expect(commands("(cd x; y=$(make)) | cat; ls")).toEqual([["make", "/repo/x"], ["cat", "/repo"], ["ls", "/repo"]]);
});

test("the ) that ends a case pattern does not end a subshell", () => {
  // the pattern's words are dropped; `case a in` and `esac` reach the visitor as words
  expect(commands("(case a in a) cd x;; esac; make); ls")).toEqual(
    [["case a in", "/repo"], ["esac", "/repo/x"], ["make", "/repo/x"], ["ls", "/repo"]]);
  expect(commands("(cd x; case a in (a|b) true;; *) ls;; esac; make); pwd")).toEqual(
    [["case a in", "/repo/x"], ["true", "/repo/x"], ["ls", "/repo/x"], ["esac", "/repo/x"], ["make", "/repo/x"], ["pwd", "/repo"]]);
  expect(commands("case a in\n  a) cd x ;;\nesac\nmake")).toEqual([["case a in", "/repo"], ["esac", "/repo/x"], ["make", "/repo/x"]]);
  expect(commands("(case a in a) cd x;; esac); ls")).toEqual([["case a in", "/repo"], ["esac", "/repo/x"], ["ls", "/repo"]]);
  expect(commands("case a in a|b) cd x;; esac; ls")).toEqual([["case a in", "/repo"], ["esac", "/repo/x"], ["ls", "/repo/x"]]);
  // a subshell inside a case item still ends with its )
  expect(commands("case a in a) (cd x); make;; esac")).toEqual([["case a in", "/repo"], ["make", "/repo"], ["esac", "/repo"]]);
});

test("zsh's noglob and nocorrect run the command after them", () => {
  expect(commands("noglob nocorrect make")).toEqual([["make", "/repo"]]);
});

test("visit learns that xargs appends arguments", () => {
  const seen = [];
  visitCommands("echo 1 | xargs make; make", "/repo", (words, dir, { appended }) => {
    seen.push([words.join(" "), appended]);
  });
  expect(seen).toEqual([["echo 1", false], ["make", true], ["make", false]]);
});

test("visit learns that xargs appends arguments to what ssh, watch and env -S run", () => {
  const appended = (source) => {
    const seen = [];
    visitCommands(source, "/repo", (words, dir, { appended: adds, remote }) => {
      seen.push([words.join(" "), adds, remote]);
    });
    return seen;
  };
  const merge = (remote) => [["echo 1", false, false], ["gh pr merge 12 -R o/r", true, remote]];
  expect(appended("echo 1 | xargs ssh host gh pr merge 12 -R o/r")).toEqual(merge(true));
  expect(appended("echo 1 | xargs ssh host 'gh pr merge 12 -R o/r'")).toEqual(merge(true));
  expect(appended("echo 1 | xargs nice ssh host gh pr merge 12 -R o/r")).toEqual(merge(true));
  expect(appended("echo 1 | xargs ssh -p 22 host -- gh pr merge 12 -R o/r")).toEqual(merge(true));
  expect(appended("echo 1 | xargs watch gh pr merge 12 -R o/r")).toEqual(merge(false));
  expect(appended("echo 1 | xargs env -S 'gh pr merge 12 -R o/r'")).toEqual(merge(false));
  // every command of the remote script and the scripts nested in it
  expect(appended("echo 1 | xargs ssh host 'git status; bash -c \"make\"'")).toEqual(
    [["echo 1", false, false], ["git status", true, true], ["make", true, true], ["bash -c make", true, true]]);
  // xargs sudo and xargs env keep it; ssh without xargs, and a local ProxyCommand, do not get it
  expect(appended("echo 1 | xargs sudo gh pr merge 12")).toEqual([["echo 1", false, false], ["gh pr merge 12", true, false]]);
  expect(appended("echo 1 | xargs env gh pr merge 12")).toEqual([["echo 1", false, false], ["gh pr merge 12", true, false]]);
  expect(appended("ssh host gh pr merge 12")).toEqual([["gh pr merge 12", false, true]]);
  expect(appended("echo 1 | xargs ssh -o ProxyCommand='nc %h %p' host make")).toEqual(
    [["echo 1", false, false], ["make", true, true], ["nc %h %p", false, false]]);
});

test("ghSubcommands skips options and reports -R and others before the subcommand", () => {
  expect(ghSubcommands(["gh", "pr", "merge", "12"], 2)).toEqual({ path: ["pr", "merge"], next: 3, repo: undefined, other: undefined });
  expect(ghSubcommands(["gh", "-R", "o/r", "pr", "--repo=a/b", "merge", "-R", "x/y"], 2)).toEqual({ path: ["pr", "merge"], next: 6, repo: "a/b", other: undefined });
  expect(ghSubcommands(["gh", "-Ro/r", "pr", "merge"], 2).repo).toBe("o/r");
  expect(ghSubcommands(["gh", "-b", "x", "pr", "merge"], 2)).toEqual({ path: ["x", "pr"], next: 4, repo: undefined, other: "-b" });
});

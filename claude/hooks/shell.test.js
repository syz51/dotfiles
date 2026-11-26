import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { ghSubcommands, gitAlias, gitGlobalOptions, parseScript, visitCommands } from "./shell.js";

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

test("the bodies of `function NAME { … }` and `function NAME() { … }` are visited (dotfiles-153)", () => {
  for (const source of ["function f { make; }; f", "function f() { make; }; f", "function f () { make; }; f",
    "function f g { make; }; g", "function { make; }", "if true; then function f { make; }; fi", "function f\n{ make; }"]) {
    expect(commands(source).map(([command]) => command)).toContain("make");
  }
  expect(parseScript("function f { a; }").commands.map(({ argv }) => argv.join(" "))).toEqual(["{ a", "}"]);
  // An argument named function defines nothing.
  expect(commands("echo function { a; }")).toEqual([["echo function { a", "/repo"]]);
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
  // the input fills in the word that holds the replace string
  expect(commands("xargs -IFILE make FILE")).toEqual([["make ${xargs}", "/repo"]]);
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

test("env -S puts its words before the words after it, as one command", () => {
  expect(commands("env -S 'a b' c")).toEqual([["a b c", "/repo"]]);
  expect(commands("env -S 'gh pr' merge 12 -R o/r --admin")).toEqual([["gh pr merge 12 -R o/r --admin", "/repo"]]);
  expect(commands("env -S 'gh pr merge 12 -R good/repo' -R other/repo")).toEqual([["gh pr merge 12 -R good/repo -R other/repo", "/repo"]]);
  // env parses the split words again as its options; options after the string are the command's
  expect(commands("env -S '-C sub make all' x")).toEqual([["make all x", "/repo/sub"]]);
  expect(commands("env -S 'make' -C sub")).toEqual([["make -C sub", "/repo"]]);
  expect(commands("env -C sub --split-string='make all' x")).toEqual([["make all x", "/repo/sub"]]);
  // env changes directory once, to its last -C, from the directory it started in
  expect(commands("env -C a -S '-C b make' x")).toEqual([["make x", "/repo/b"]]);
  expect(commands("env -C a -C b make")).toEqual([["make", "/repo/b"]]);
  expect(commands("env -C a env -C b make")).toEqual([["make", "/repo/a/b"]]);
  expect(commands("env -iS'FOO=1 make' x")).toEqual([["make x", "/repo"]]);
  // env's own quoting, escapes and comments, not the shell's: a `;` is a word
  const words = (source) => {
    const seen = [];
    visitCommands(source, "/repo", (argv) => { seen.push(argv); });
    return seen;
  };
  expect(words(`env -S "a 'b c' \\"d e\\" f\\\\_g # h" i`)).toEqual([["a", "b c", "d e", "f", "g", "i"]]);
  expect(words(`env -S "'x\\\\'y' \\"p\\\\tq\\"" r`)).toEqual([["x'y", "p\tq", "r"]]);
  expect(words("env -S 'a;b' c")).toEqual([["a;b", "c"]]);
  expect(words("env -S 'a \\c b' c")).toEqual([["a", "c"]]);
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

test("a directory a remote script names stays unknown here", () => {
  const visits = (source) => {
    const seen = [];
    visitCommands(source, "/repo", (words, dir, { remote }) => {
      seen.push([words.join(" "), dir, remote]);
    });
    return seen;
  };
  expect(visits("ssh host 'cd /abs && make'")).toEqual([["make", undefined, true]]);
  expect(visits("ssh host 'cd ~/app; pushd /abs; make'")).toEqual([["make", undefined, true]]);
  expect(visits("ssh host 'cd; make'")).toEqual([["make", undefined, true]]);
  expect(visits("ssh host sudo -D /abs make")).toEqual([["make", undefined, true]]);
  expect(visits("ssh host env -C /abs make")).toEqual([["make", undefined, true]]);
  expect(visits("ssh host 'sh -c \"cd /abs && make\"'")).toEqual([["make", undefined, true], ["sh -c cd /abs && make", undefined, true]]);
  expect(visits("ssh host bash -s <<'EOF'\ncd /abs\nmake\nEOF")).toEqual([["bash -s", undefined, true], ["make", undefined, true]]);
  // the local side still follows its directory changes
  expect(visits("cd /abs && ssh host make; make")).toEqual([["make", undefined, true], ["make", "/abs", false]]);
  expect(visits("env -C /abs ssh -o ProxyCommand='nc proxy' host make")).toEqual([["make", undefined, true], ["nc proxy", "/abs", false]]);
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

test("ssh -o RemoteCommand runs its command on the remote host", () => {
  expect(commands("ssh -o RemoteCommand='make test' host")).toEqual([["make test", undefined]]);
  expect(commands("ssh -o 'RemoteCommand make' -o ProxyCommand='nc proxy' host")).toEqual([["make", undefined], ["nc proxy", "/repo"]]);
  expect(commands("ssh -oRemoteCommand=none host")).toEqual([]);
  expect(commands("echo make | ssh -o RemoteCommand='bash -s' host")).toContainEqual(["make", undefined]);
});

test("sshpass runs ssh, past its options that take a value", () => {
  expect(commands("sshpass -p pw ssh host make")).toEqual([["make", undefined]]);
  expect(commands("sshpass -e ssh host make")).toEqual([["make", undefined]]);
  expect(commands("sshpass -f pass.txt -P assword ssh host make")).toEqual([["make", undefined]]);
});

test("ssh -n, -f and -N keep ssh from reading standard input", () => {
  for (const option of ["-n", "-f", "-N", "-nT"]) {
    expect(commands(`echo make | ssh ${option} host`)).not.toContainEqual(["make", undefined]);
    expect(commands(`ssh ${option} host bash -s <<< make`)).not.toContainEqual(["make", undefined]);
  }
  expect(commands("echo make | ssh host -n")).not.toContainEqual(["make", undefined]);
  expect(commands("echo make | ssh host")).toContainEqual(["make", undefined]);
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
    visitCommands(source, "/repo", (words, dir, { appended: adds, opaque, remote }) => {
      if (!opaque) seen.push([words.join(" "), adds, remote]);
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
  // env -S puts its words first: ssh is an argument of gh, and so are the words xargs adds
  expect(appended("echo 1 | xargs env -S 'gh pr merge 12 -R o/r' ssh")).toEqual([["echo 1", false, false], ["gh pr merge 12 -R o/r ssh", true, false]]);
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

test("visit reports a command that xargs supplies or parses again as opaque", () => {
  // The opaque visits of `source`, each as [words, dir, appended, remote].
  const opaque = (source) => {
    const seen = [];
    visitCommands(source, "/repo", (words, dir, flags) => {
      if (flags.opaque) seen.push([words.join(" "), dir, flags.appended, flags.remote]);
    });
    return seen;
  };
  // 1: ssh and watch parse the added words again as a script
  expect(opaque("echo '; gh pr merge 12 -R o/r --admin' | xargs ssh host true")).toEqual([["xargs ssh host true", "/repo", true, false]]);
  expect(opaque("echo '; gh pr merge 12 -R o/r --admin' | xargs watch true")).toEqual([["xargs watch true", "/repo", true, false]]);
  // 2: ssh with no host or command, and options added after the host
  expect(opaque("echo 'host gh pr merge 12' | xargs ssh")).toEqual([["xargs ssh", "/repo", true, false]]);
  expect(opaque("echo 'host gh pr merge 12' | xargs ssh -p 22")).toEqual([["xargs ssh -p 22", "/repo", true, false]]);
  expect(opaque("echo '-oProxyCommand=gh\\ pr\\ merge\\ 12' | xargs ssh host")).toEqual([["xargs ssh host", "/repo", true, false]]);
  // 3: wrappers with no command, a second xargs, an empty env -S, and a shell's -c without its script
  for (const wrapper of ["sudo", "env", "nice", "xargs", "env -S ''", "env FOO=1", "bash -c", "sh -ec", "fish --command", "eval"]) {
    expect(opaque(`echo 'gh pr merge 12' | xargs ${wrapper}`)).toEqual([[`xargs ${wrapper}`.replace("''", ""), "/repo", true, false]]);
  }
  // an env -S string that is only a wrapper, and a remote shell's empty sudo
  expect(opaque("echo 'gh pr merge 12' | xargs env -S 'sudo -u me'")).toEqual([["xargs env -S sudo -u me", "/repo", true, false]]);
  // 4: xargs supplies gh's subcommand; the gh command is appended, and over ssh the whole ssh command is opaque
  expect(opaque("echo 'merge 12' | xargs gh pr")).toEqual([]);
  expect(opaque("echo 'merge 12' | xargs ssh host gh pr")).toEqual([["xargs ssh host gh pr", "/repo", true, false]]);
  // 5: find runs an -exec the added words supply
  expect(opaque("echo '-exec gh pr merge 12 ;' | xargs find . -maxdepth 0")).toEqual([["xargs find . -maxdepth 0", "/repo", true, false]]);
  // 6: a piped reader joins the lines into one command
  expect(opaque("printf 'gh pr merge 12\\n--admin\\n' | xargs ssh host")).toEqual([["xargs ssh host", "/repo", true, false]]);
  // inside a remote script, an opaque command runs on that host
  expect(opaque("ssh host 'echo x | xargs sudo'")).toEqual([["xargs sudo", undefined, true, true]]);
  // -I puts the input in a shell's script, an env -S script or the command name
  expect(opaque("echo x | xargs -I{} sh -c 'git push origin {}'")).toEqual([["xargs -I{} sh -c git push origin {}", "/repo", true, false]]);
  expect(opaque("echo x | xargs -I % env -S 'gh %'")).toEqual([["xargs -I % env -S gh %", "/repo", true, false]]);
  expect(opaque("echo gh | xargs --replace={} {} pr merge 12")).toEqual([["xargs --replace={} {} pr merge 12", "/repo", true, false]]);
  expect(opaque("echo x | xargs -i sh -c '{}'")).toEqual([["xargs -i sh -c {}", "/repo", true, false]]);
  // 7: a push that xargs adds to is appended, not opaque
  expect(opaque("echo --force | xargs git push origin main")).toEqual([]);
  // benign forms, xargs alone (it runs echo), a shell with its script, and the same commands without xargs
  for (const source of ["git ls-files | xargs grep foo", "ls | xargs -n1 basename", "find . -name x | xargs rm -f", "echo a | xargs",
    "ls | xargs sh -c 'wc -l \"$@\"' _", "find . -name x | xargs -I{} rm -f {}", "ssh host true", "sudo", "watch true", "find . -exec rm {} ;", "env -S 'gh pr view' 12"]) {
    expect(opaque(source)).toEqual([]);
  }
});

test("ghSubcommands skips options and reports -R and others before the subcommand", () => {
  expect(ghSubcommands(["gh", "pr", "merge", "12"], 2)).toEqual({ path: ["pr", "merge"], next: 3, repo: undefined, other: undefined });
  expect(ghSubcommands(["gh", "-R", "o/r", "pr", "--repo=a/b", "merge", "-R", "x/y"], 2)).toEqual({ path: ["pr", "merge"], next: 6, repo: "a/b", other: undefined });
  expect(ghSubcommands(["gh", "-Ro/r", "pr", "merge"], 2).repo).toBe("o/r");
  expect(ghSubcommands(["gh", "-b", "x", "pr", "merge"], 2)).toEqual({ path: ["x", "pr"], next: 4, repo: undefined, other: "-b" });
});

test("gitGlobalOptions reads the directory, the settings in order, another repository and the subcommand", () => {
  const words = ["git", "-C", "sub", "-c", "Alias.P=push", "--config-env", "core.pager=PAGER", "--config-env=user.name=NAME", "-p", "push", "-c", "x=y"];
  expect(gitGlobalOptions(words, "/repo")).toEqual({
    dir: "/repo/sub",
    settings: [
      { option: "-c", setting: "Alias.P=push", key: "alias.p", value: "push" },
      { option: "--config-env", setting: "core.pager=PAGER", key: "core.pager", value: "PAGER" },
      { option: "--config-env", setting: "user.name=NAME", key: "user.name", value: "NAME" },
    ],
    otherRepo: false,
    index: 9,
  });
  expect(gitGlobalOptions(["git", "--work-tree=.", "-c", "flag", "status"], "/repo")).toMatchObject({
    otherRepo: true, settings: [{ key: "flag", value: undefined }], index: 4,
  });
  expect(gitGlobalOptions(["git", "--git-dir", ".git"], "/repo")).toMatchObject({ otherRepo: true, index: 3 });
  // -C as the last word changes nothing, and the subcommand index is past the end
  expect(gitGlobalOptions(["git", "-C"], "/repo")).toMatchObject({ dir: "/repo", index: 3 });
});

test("gitAlias follows -c aliases and reports those it cannot read", () => {
  const settings = (...words) => gitGlobalOptions(["git", ...words], "/repo").settings;
  expect(gitAlias(settings("-c", "alias.p=push --force"), "p")).toEqual({ words: ["push", "--force"] });
  expect(gitAlias(settings("-c", "alias.a=b x", "-c", "alias.b=push -f"), "a")).toEqual({ words: ["push", "-f", "x"] });
  expect(gitAlias(settings("-c", "alias.push=status"), "push")).toBeUndefined();
  expect(gitAlias(settings("-c", "alias.p=push"), "q")).toBeUndefined();
  expect(gitAlias(settings("-c", "alias.p=push"), undefined)).toBeUndefined();
  for (const words of [["--config-env", "alias.p=V"], ["-c", "alias.p=!sh"], ["-c", "alias.p"], ["-c", "alias.p= "],
    ["-c", "alias.p=-C x push"], ["-c", "alias.p='push'"], ["-c", "alias.p=$X"], ["-c", "alias.p=q", "-c", "alias.q=p"]]) {
    expect(gitAlias(settings(...words), "p")).toEqual({ unknown: words.at(-1) === "alias.q=p" ? "alias.p=q" : words[1] });
  }
});

test("a cd in eval, source or a non-last piped compound command marks the directory uncertain with candidates (dotfiles-306)", () => {
  const lastMake = (source, cwd = "/repo") => {
    let found;
    visitCommands(source, cwd, (words, dir, { dirs }) => {
      if (words[0] === "make") found = { dir, dirs };
    });
    return found;
  };
  // eval
  expect(lastMake("eval cd /other; make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake("eval 'cd sub'; make")).toEqual({ dir: undefined, dirs: ["/repo", "/repo/sub"] });
  expect(lastMake("eval -- cd /other; make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake("eval - cd /other; make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake("eval \"eval 'cd /other'\"; make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake("eval 'cd $X'; make")).toEqual({ dir: undefined, dirs: ["/repo"] });
  expect(lastMake("eval 'echo hi'; make")).toEqual({ dir: "/repo", dirs: undefined });
  expect(lastMake("eval '(cd /other)'; make")).toEqual({ dir: "/repo", dirs: undefined });
  expect(lastMake("eval 'cd /other' | cat; make")).toEqual({ dir: "/repo", dirs: undefined });
  expect(lastMake("true | eval 'cd /other'; make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  // source and .
  expect(lastMake("source /dev/stdin <<< 'cd /other'; make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake(". /dev/stdin <<< 'cd /other'; make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake("echo 'cd /other' | source /dev/stdin; make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake("source /dev/stdin < <(echo 'cd /other'); make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake("source <(echo 'cd /other'); make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake(". <(printf 'cd /other\\n'); make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake("source =(echo 'cd /other'); make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake("source /dev/stdin <<< 'cd /other' | cat; make")).toEqual({ dir: "/repo", dirs: undefined });
  // non-last piped or backgrounded compound commands
  expect(lastMake("while read l; do cd /other; done < f | cat; make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake("time while read l; do cd /other; done | cat; make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake("until false; do cd /other; done | cat; make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake("for x in a b; do cd /other; done | cat; make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake("if true; then cd /other; fi | cat; make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake("case a in a) cd /other;; esac | cat; make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake("while read l; do cd /other; done |& cat; make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake("while read l; do cd /other; done & make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake("while read l; do cd /other; done | make")).toEqual({ dir: undefined, dirs: ["/repo", "/other"] });
  expect(lastMake("while read l; do echo hi; done | cat; make")).toEqual({ dir: "/repo", dirs: undefined });
  expect(lastMake("while read l; do (cd /other); done | cat; make")).toEqual({ dir: "/repo", dirs: undefined });
  // remote piped compound commands stay plain unknown without dirs
  expect(lastMake("ssh host 'while read l; do cd /other; done | cat; make'")).toEqual({ dir: undefined, dirs: undefined });
  // compound command as whole command or last part of a pipeline stays tracked as today
  expect(lastMake("while read l; do cd /other; done; make")).toEqual({ dir: "/other", dirs: undefined });
  expect(lastMake("echo a | while read l; do cd /other; done; make")).toEqual({ dir: "/other", dirs: undefined });
  expect(lastMake("for x in a; do cd /other; done; make")).toEqual({ dir: "/other", dirs: undefined });
  expect(lastMake("if true; then cd /other; fi; make")).toEqual({ dir: "/other", dirs: undefined });
  expect(lastMake("case a in a) cd /other;; esac; make")).toEqual({ dir: "/other", dirs: undefined });
  // relative cd and wrappers propagate across candidate dirs; absolute cd and plain cd $X reset
  expect(lastMake("eval cd /other; cd sub; make")).toEqual({ dir: undefined, dirs: ["/repo/sub", "/other/sub"] });
  expect(lastMake("eval cd /other; env -C sub make")).toEqual({ dir: undefined, dirs: ["/repo/sub", "/other/sub"] });
  expect(lastMake("eval cd /other; cd /abs; make")).toEqual({ dir: "/abs", dirs: undefined });
  expect(lastMake("cd $X; make")).toEqual({ dir: undefined, dirs: undefined });
  // subshell still isolates uncertain state
  expect(lastMake("(eval cd /other); make")).toEqual({ dir: "/repo", dirs: undefined });
});

test("( and ) inside ${...} do not open or close subshells or substitutions (dotfiles-308)", () => {
  const { commands: parsed } = parseScript("(echo ${x/)/y}; cd /tmp)");
  expect(parsed.map(({ argv, opens, closes, next }) => [argv, opens, closes, next])).toEqual([
    [["echo", "${x/)/y}"], 1, 0, ";"],
    [["cd", "/tmp"], 0, 1, undefined],
  ]);
  expect(commands("(echo ${line#*)}; cd /tmp); make")).toEqual([["echo ${line#*)}", "/repo"], ["make", "/repo"]]);
  expect(commands("(cd /tmp; echo ${x/(/y}); make")).toEqual([["echo ${x/(/y}", "/tmp"], ["make", "/repo"]]);
  // nested ${...}, quotes and escaped } inside ${...}
  expect(commands("(echo ${a:-${b/)/c}}; cd /tmp); make")).toEqual([["echo ${a:-${b/)/c}}", "/repo"], ["make", "/repo"]]);
  expect(commands("(echo ${x/\\})/y}; cd /tmp); make")).toEqual([["echo ${x/\\})/y}", "/repo"], ["make", "/repo"]]);
  expect(commands("(echo ${a:-'x}y)'}; cd /tmp); make")).toEqual([["echo ${a:-'x}y)'}", "/repo"], ["make", "/repo"]]);
  expect(commands("(echo ${a:-$'x\\'}y)'}; cd /tmp); make")).toEqual([["echo ${a:-$'x\\'}y)'}", "/repo"], ["make", "/repo"]]);
  expect(commands('(echo "${a:-"x)y}"}"; cd /tmp); make')).toEqual([['echo ${a:-"x)y}"}', "/repo"], ["make", "/repo"]]);
  // inside double-quoted "${...}", single quotes and $' are literal (POSIX/zsh) and do not swallow } or $(...)
  expect(commands('echo "${x:-\'}"; make')).toEqual([["echo ${x:-'}", "/repo"], ["make", "/repo"]]);
  expect(commands('echo "${x:-$\'}"; make')).toEqual([["echo ${x:-$'}", "/repo"], ["make", "/repo"]]);
  expect(commands('echo "${x:-\'$(make q)\'}"')).toEqual([["make q", "/repo"], ["echo ${x:-'$(make q)'}", "/repo"]]);
  // substitutions inside ${...} and ${...}/backticks/nested double quotes inside $(...) are still visited
  expect(commands("echo ${x:-$(make a)}")).toEqual([["make a", "/repo"], ["echo ${x:-$(make a)}", "/repo"]]);
  expect(commands('echo "${x:-$(make b)}"')).toEqual([["make b", "/repo"], ["echo ${x:-$(make b)}", "/repo"]]);
  expect(commands("echo ${x:-`make c`}")).toEqual([["make c", "/repo"], ["echo ${x:-`make c`}", "/repo"]]);
  expect(commands("echo $(echo ${x/)/y}; make d)")).toEqual([["echo ${x/)/y}", "/repo"], ["make d", "/repo"], ["echo $(echo ${x/)/y}; make d)", "/repo"]]);
  expect(commands("echo $(echo `echo ')'`; make e)")).toEqual([["echo )", "/repo"], ["echo `echo ')'`", "/repo"], ["make e", "/repo"], ["echo $(echo `echo ')'`; make e)", "/repo"]]);
  expect(commands('echo $(echo "${x:-"a)b"}"; make f)')).toEqual([['echo ${x:-"a)b"}', "/repo"], ["make f", "/repo"], ['echo $(echo "${x:-"a)b"}"; make f)', "/repo"]]);
  expect(commands('echo $(echo "$(echo ")")"; make g)')).toEqual([["echo )", "/repo"], ["echo $(echo \")\")", "/repo"], ["make g", "/repo"], ['echo $(echo "$(echo ")")"; make g)', "/repo"]]);
});

test("ANSI-C $'...' handles \\' and \\\\ escapes without breaking later commands or quoting backticks (dotfiles-308)", () => {
  const { commands: parsed } = parseScript("echo $'a\\'b'; git push");
  expect(parsed.map(({ argv, next }) => [argv, next])).toEqual([
    [["echo", "a'b"], ";"],
    [["git", "push"], undefined],
  ]);
  expect(commands("echo $'\\''; make")).toEqual([["echo '", "/repo"], ["make", "/repo"]]);
  expect(commands("echo $'a\\\\'; make")).toEqual([["echo a\\", "/repo"], ["make", "/repo"]]);
  expect(commands("echo $'a\\\\\\'b'; make")).toEqual([["echo a\\'b", "/repo"], ["make", "/repo"]]);
  // backticks and $(...) after \' inside $'...' stay quoted text (board-feedback-1219)
  const quoted = parseScript("board add --body $'...T3 Code\\'s ... `gh pr merge` ... \\`gh pr merge\\` ... $(make)...'");
  expect(quoted.commands).toHaveLength(1);
  expect(quoted.commands[0].substitutions).toEqual([]);
  // $'...' inside $(...) does not close the substitution early, and decoded quotes reach sh -c / eval
  expect(commands("echo $(echo $'a\\')'; make)")).toEqual([["echo a')", "/repo"], ["make", "/repo"], ["echo $(echo $'a\\')'; make)", "/repo"]]);
  expect(commands("sh -c $'echo \\'\"\\'; make'").map(([cmd]) => cmd)).toContain("make");
  expect(commands("sh -c $'echo \\' #\\'; make'").map(([cmd]) => cmd)).toContain("make");
  expect(commands("sh -c $'echo \\'${\\'; make'").map(([cmd]) => cmd)).toContain("make");
  expect(commands("eval $'cd /other\\nmake'")).toContainEqual(["make", "/other"]);
});

test("visit reports topLevel, piped, and background execution context (dotfiles-756)", () => {
  const ctx = (source) => {
    const seen = [];
    visitCommands(source, "/repo", (words, _dir, { topLevel, piped, background }) => {
      seen.push([words.join(" "), topLevel, piped, background]);
    });
    return seen;
  };
  // top-level sequential lists
  expect(ctx("a && b; c\nd")).toEqual([
    ["a", true, false, false],
    ["b", true, false, false],
    ["c", true, false, false],
    ["d", true, false, false],
  ]);
  // pipelines and backgrounded jobs
  expect(ctx("a | b && c")).toEqual([
    ["a", false, true, false],
    ["b", false, true, false],
    ["c", true, false, false],
  ]);
  expect(ctx("a & b")).toEqual([
    ["a", false, false, true],
    ["b", true, false, false],
  ]);
  expect(ctx("a && b & c")).toEqual([
    ["a", false, false, true],
    ["b", false, false, true],
    ["c", true, false, false],
  ]);
  expect(ctx("{ a; } & b")).toEqual([
    ["a", false, false, true],
    ["b", true, false, false],
  ]);
  expect(ctx("(a &) && b")).toEqual([
    ["a", false, false, true],
    ["b", true, false, false],
  ]);
  expect(ctx("coproc a; b")).toEqual([
    ["a", false, false, true],
    ["b", true, false, false],
  ]);
  expect(ctx("({ a; b; } &) && c")).toEqual([
    ["a", false, false, true],
    ["b", false, false, true],
    ["c", true, false, false],
  ]);
  expect(ctx("c && ({ a; b; } &)")).toEqual([
    ["c", true, false, false],
    ["a", false, false, true],
    ["b", false, false, true],
  ]);
  expect(ctx("((a; b) &) && c")).toEqual([
    ["a", false, false, true],
    ["b", false, false, true],
    ["c", true, false, false],
  ]);
  expect(ctx("({ a; } && b &) && c")).toEqual([
    ["a", false, false, true],
    ["b", false, false, true],
    ["c", true, false, false],
  ]);
  expect(ctx("(for i in 1; do a; done &) && c").find(([cmd]) => cmd === "a")).toEqual(["a", false, false, true]);
  expect(ctx("(for i in 1; do a; done &) && c").at(-1)).toEqual(["c", true, false, false]);
  expect(ctx("coproc { a; b; } && c")).toEqual([
    ["a", false, false, true],
    ["b", false, false, true],
    ["c", true, false, false],
  ]);
  expect(ctx("coproc (a; b) && c")).toEqual([
    ["a", false, false, true],
    ["b", false, false, true],
    ["c", true, false, false],
  ]);
  expect(ctx("coproc NAME (a; b) && c").filter(([cmd]) => cmd !== "NAME")).toEqual([
    ["a", false, false, true],
    ["b", false, false, true],
    ["c", true, false, false],
  ]);
  expect(ctx("c && { a & b; }")).toEqual([
    ["c", true, false, false],
    ["a", false, false, true],
    ["b", false, false, false],
  ]);
  expect(ctx("c && coproc { a; b; }")).toEqual([
    ["c", true, false, false],
    ["a", false, false, true],
    ["b", false, false, true],
  ]);
  // loops, functions, groups, subshells, conditionals, and nested scripts are not top-level
  for (const [source, target] of [
    ["for i in 1 2; do a; b; done", "a"],
    ["while true; do a; b; done", "a"],
    ["until false; do a; b; done", "a"],
    ["select x in 1 2; do a; b; done", "a"],
    ["repeat 2; do a; b; done", "a"],
    ["if true; then a; fi", "a"],
    ["case x in x) a;; esac", "a"],
    ["{ a; b; }", "a"],
    ["(a; b)", "a"],
    ["f() { a; b; }", "a"],
    ["function f { a; b; }", "a"],
    ["f() a; b", "a"],
    ["bash -c 'a && b'", "a"],
    ["x=$(a); b", "a"],
  ]) {
    const entry = ctx(source).find(([cmd]) => cmd === target);
    expect(entry, source).toEqual([target, false, false, false]);
  }
  // commands after a closed loop, function, or empty array assignment return to top-level
  expect(ctx("for i in 1; do a; done && b").at(-1)).toEqual(["b", true, false, false]);
  expect(ctx("f() { a; }; b").at(-1)).toEqual(["b", true, false, false]);
  expect(ctx("x=(); b").at(-1)).toEqual(["b", true, false, false]);
  // process substitutions <(...) and >(...) run concurrently over pipes (piped + background)
  expect(ctx("a > >(b)")).toEqual([
    ["b", false, true, true],
    ["a", true, false, false],
  ]);
  expect(ctx("a 2> >(b)")).toEqual([
    ["b", false, true, true],
    ["a", true, false, false],
  ]);
  expect(ctx("a < <(b)")).toEqual([
    ["b", false, true, true],
    ["a", true, false, false],
  ]);
  expect(ctx("a --file=<(b)")).toEqual([
    ["b", false, true, true],
    ["a --file=<(b)", true, false, false],
  ]);
  expect(ctx("echo hi > >(b) && c")).toEqual([
    ["b", false, true, true],
    ["echo hi", true, false, false],
    ["c", true, false, false],
  ]);
  expect(ctx("(a) > >(b) && c")).toEqual([
    ["b", false, true, true],
    ["a", false, false, false],
    ["c", true, false, false],
  ]);
  expect(ctx("> >(b) && c")).toEqual([
    ["b", false, true, true],
    ["c", true, false, false],
  ]);
  // zsh =(...) runs synchronously into a temporary file, so it is nested but not piped/background
  expect(ctx("a < =(b)")).toEqual([
    ["b", false, false, false],
    ["a", true, false, false],
  ]);
  // no-space zsh redirections to process substitutions (>>(...), >>>(...), >|>(...), <<(...))
  for (const source of ["a >>(b)", "a >>>(b)", "a >|>(b)", "a 2>>(b)", "a 2>|>(b)", "a <<(b)"]) {
    expect(ctx(source), source).toEqual([
      ["b", false, true, true],
      ["a", true, false, false],
    ]);
  }
  // quoted closing keywords do not close an enclosing loop, conditional, or brace group
  expect(ctx('for i in 1 2; do echo ok; "done"; a; b; done').find(([cmd]) => cmd === "a")).toEqual(["a", false, false, false]);
  expect(ctx('{ echo ok; "}"; a; b; }').find(([cmd]) => cmd === "a")).toEqual(["a", false, false, false]);
  expect(ctx('if true; then echo ok; "fi"; a; b; fi').find(([cmd]) => cmd === "a")).toEqual(["a", false, false, false]);
  expect(ctx('{ a; "}"; echo ok; } & c').find(([cmd]) => cmd === "a")).toEqual(["a", false, false, true]);
});

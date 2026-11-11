import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findViolation } from "./guard-git-push.js";

const HOOK = join(import.meta.dir, "guard-git-push.js");

// Checkouts by directory: /repo is on `feature`, /other is on `main`; both push to
// origin/<branch>, and origin/HEAD is `remoteHead`, or `remoteHead[dir]` when it is an object.
// `config` is what `git config --get-regexp` prints. `calls` records every query.
function fakeGit({ branch = "feature", remoteHead = "origin/main", config, calls = [] } = {}) {
  const branches = { "/repo": branch, "/other": "main" };
  return (dir, args) => {
    calls.push([dir, ...args]);
    if (args[0] === "config") return config;
    const query = args.join(" ");
    if (query === "symbolic-ref --quiet --short HEAD") return branches[dir];
    if (query === "rev-parse --abbrev-ref --symbolic-full-name @{push}") return branches[dir] && `origin/${branches[dir]}`;
    if (query.startsWith("symbolic-ref --quiet --short refs/remotes/")) return remoteHead !== null && typeof remoteHead === "object" ? remoteHead[dir] : remoteHead;
    return undefined;
  };
}

const verdict = (command, repo) => findViolation(command, "/repo", fakeGit(repo));

describe("blocks", () => {
  test.each([
    ["git push --force origin main"],
    ["git push -f origin main"],
    ["git push -uf origin master"],
    ["git push origin +main"],
    ["git push origin +HEAD:main"],
    ["git push origin feature:refs/heads/main --force"],
    ["git push --force-with-lease=main:abc123 origin main"],
    ["git push --force-with-lease origin HEAD:master"],
    ["git push origin --delete main"],
    ["git push origin :main"],
    ["git push --mirror origin"],
    ["git push --force --all"],
    ["git push --force origin develop", { remoteHead: "origin/develop" }],
    ["git push --force", { branch: "main" }],
    ["git push --force-with-lease=main:abc123", { branch: "main" }],
    ["git push --force origin feature"],
    ["git push origin +feature"],
    ["git push --force-with-lease origin feature"],
    ["git push --force-with-lease=feature origin feature"],
    // git accepts unambiguous abbreviations of long options
    ["git push --force-w origin main"],
    ["git push --forc origin feature"],
    ["git push --mir origin"],
    ["git push --del origin main"],
    ["git push --dry-run --no-dry-run --force origin main"],
    // shells, wrappers, and substitutions
    ["cd repo && git push -f origin main"],
    ["FOO=1 git -C sub push -f origin main"],
    ["sudo -u me git push -f origin main"],
    ["timeout 30 git push -f origin main"],
    ["/usr/bin/git push --force origin main"],
    ["bash -lc 'git push --force origin main'"],
    ["bash -o pipefail -c 'git push -f origin main'"],
    ['eval "git push -f origin main"'],
    ["git push -f origin main 2>&1 | tail -1"],
    ["(git push --force origin main)"],
    ["git fetch && git push --force origin main"],
    ["out=$(git push -f origin main)"],
    ['echo "$(git push -f origin main)"'],
    ['x="`git push -f origin main`"'],
    ["bash <<EOF\ngit push -f origin main\nEOF"],
    ["cat <<'EOF' | sh\ngit push --force origin main\nEOF"],
    ["sh -s <<EOF\ngit push --force origin main\nEOF"],
    ["bash <<< 'git push -f origin main'"],
    ['env -S "git push -f origin main"'],
    ["xargs git push -f origin main </dev/null"],
    ["watch -n 5 git push -f origin main"],
    ["stdbuf -oL git push -f origin main"],
    ["sudo -iu me git push -f origin main"],
    ["find . -maxdepth 0 -exec git push -f origin main \\;"],
    ["echo 'git push -f origin main' | bash"],
    ["ssh -p 22 host 'cd repo && git push --force origin main'"],
    ["ssh host git push -f origin feature"],
    ["ssh host <<'EOF'\ngit push -f origin main\nEOF"],
    ["sudo -uhugh git push -f origin main"],
    ["fish --command 'git push -f origin main'"],
    // -execdir runs in each match's directory, whose branch is unknown here.
    ["find /other -maxdepth 1 -name .git -execdir git push --force-with-lease=HEAD:abc123 origin HEAD \\;"],
    // the directory a push runs in
    ["cd /other && git push --force-with-lease=main:abc123"],
    ["env -C /other git push --force-with-lease=main:abc123"],
    ['cd "$REPO" && git push --force-with-lease=feature:abc123'],
    // words the shell fills in, which could be `+x:main`, `:main` or `--force`
    ['git push origin "$(cat refspec)"'],
    ["git push origin $(cat refspec)"],
    ["git push origin `cat refspec`"],
    ["git push origin $REF"],
    ['git push origin "${BRANCH}:main"'],
    ["git push $(echo --force) origin main"],
    ["git push origin $(echo feature) --force"],
    ['git push "$REMOTE"'],
    ["git push --$MODE origin feature"],
    ["git push -$FLAGS origin feature"],
    ["git push -- origin $REF"],
    // remote.<name>.push refspecs replace the current branch when no refspec is given
    ["git push", { config: "remote.origin.push +refs/heads/x:refs/heads/main" }],
    ["git push origin", { config: "remote.origin.push +refs/heads/x:refs/heads/main" }],
    ["git push", { config: "remote.origin.push refs/heads/feature:refs/heads/feature\nremote.origin.push :main" }],
    ["git push --force-with-lease=feature:abc123", { config: "remote.origin.push refs/heads/*:refs/heads/*" }],
    ["git push", { config: "remote.pushdefault fork\nremote.fork.push +HEAD:main" }],
    ["git push", { config: "branch.feature.pushremote fork\nremote.fork.push +HEAD:main" }],
    ["git push", { config: "branch.feature.remote fork\nremote.fork.push +HEAD:main" }],
    ["git push --force origin :"],
    // brace expansion, a filled-in word after --dry-run, and a filled-in command name or subcommand
    ["git push origin {--force,main}"],
    ["git push origin feature{,:main}"],
    ["git push --dry-run $(echo --no-dry-run) --force origin main"],
    ["git push -n $X --force origin main"],
    ['git push --dry-run origin "$REF"'],
    ["git $(echo push) --force origin main"],
    ['git "$SUB" -f origin main'],
    ["sudo $(which git) push -f origin main"],
    ["$GIT push -f origin main"],
    // push configuration from -c, --config-env, or an earlier command
    ["git -c remote.origin.push=+HEAD:main push"],
    ["git -c Remote.origin.Mirror=true push"],
    ["git --config-env=remote.origin.push=REFSPEC push"],
    ["git -c $SETTING push origin feature"],
    ["git config remote.origin.push +HEAD:main; git push"],
    ["git config --add remote.origin.mirror true && git push origin"],
    // remote.<name>.mirror, --repo, and the push remote's own default branch
    ["git push", { config: "remote.origin.mirror true" }],
    ["git push --repo=fork", { config: "remote.fork.push +HEAD:main" }],
    ["git push --repo fork", { config: "remote.fork.push +HEAD:main" }],
    ['git push --repo="$R"'],
    ["git push --force-with-lease=develop:abc123", { config: "remote.pushdefault fork\nremote.fork.push HEAD:develop", remoteHead: "fork/develop" }],
    // text echoed through a substitution into a shell, a case pattern inside $( ), a heredoc
    ["echo $(echo git push -f origin main) | sh"],
    ["printf '%s ' $(echo git push -f origin main) | sh"],
    ["echo $(case x in x) git push -f origin main;; esac)"],
    ['(echo git push -f origin main) 2>"$HOME/$(echo err)" | sh'],
    ["cat <<EOF\n$(git push -f origin main)\nEOF"],
    ["cat <<EOF\n`git push -f origin main`\nEOF"],
  ])("%s", (command, repo = {}) => {
    expect(verdict(command, repo)).toBeDefined();
  });
});

describe("allows", () => {
  test.each([
    ["git push"],
    ["git push -u origin feature"],
    ["git push origin main"],
    ["git push origin HEAD"],
    ["git push --all origin"],
    ["git push --tags"],
    ["git push --force-with-lease=feature:abc123 origin feature"],
    ["git push --force-with-lease=feature:abc123 --force-if-includes origin HEAD"],
    ["git push --force-w=feature:abc123 origin feature"],
    ["git push --force-with-lease=feature:abc123", { branch: "feature" }],
    ["git push --dry-run --force origin main"],
    ["git push --dry --force origin main"],
    ["git push -nf origin main"],
    ["git push origin --delete old-feature"],
    ["git push -o ci.skip origin feature"],
    ["cd /other && git push origin main"],
    ['cd "$REPO" && git push --force-with-lease=feature:abc123 origin feature'],
    ["echo git push --force origin main"],
    ["grep -rn 'git push --force' ."],
    ["git commit -m 'never git push --force origin main'"],
    ["git log --oneline # git push -f origin main"],
    ["git commit -F- <<'EOF'\nBlock git push --force origin main\nEOF\ngit push origin feature"],
    ["cat <<-EOF > notes.txt\n\tgit push -f origin main\n\tEOF"],
    ["cat <<EOF > deploy.sh\ngit push -f origin main\nEOF"],
    ["bash -c 'echo hi' && git push origin feature"],
    ["git status > /dev/null && ls"],
    // command -v only looks the command up
    ["command -v git push -f origin main"],
    ["ssh host 'git push origin feature'"],
    ["ssh -o ConnectTimeout=5 host git fetch"],
    ["echo 'git push -f origin main' > notes.txt"],
    ["find . -name '*.md' -exec grep -l 'git push -f' {} +"],
    // an option value from a variable leaves the option and the refspec known
    ["git push --force-with-lease=feature:$SHA origin feature"],
    ['git push -o "$OPTION" origin feature'],
    ["git push -o$OPTION origin feature"],
    ['echo "$(git push origin feature)"'],
    ["cat <<'EOF'\n$(git push -f origin main)\nEOF"],
    ["git -c user.name=me push origin feature"],
    ["git config user.name me; git push"],
    ["git push --tags --force-with-lease=v1:abc123", { config: "remote.origin.push refs/heads/*:refs/heads/*" }],
    ["git push --repo=fork", { config: "remote.origin.push +HEAD:main" }],
    ["$EDITOR push.txt"],
    ["git push", { config: "remote.origin.push refs/heads/feature:refs/heads/feature" }],
    ["git push", { config: "remote.upstream.push +HEAD:main" }],
    ["git push origin", { config: "remote.pushdefault fork\nremote.fork.push +HEAD:main" }],
    ["git push origin feature", { config: "remote.origin.push +HEAD:main" }],
  ])("%s", (command, repo = {}) => {
    expect(verdict(command, repo)).toBeUndefined();
  });
});

test("pushes with refspecs make no git queries, and a push without one reads only the push config", () => {
  const calls = [];
  expect(findViolation("git push origin feature && git push origin HEAD", "/repo", fakeGit({ calls }))).toBeUndefined();
  expect(calls).toEqual([]);
  expect(findViolation("git push", "/repo", fakeGit({ calls }))).toBeUndefined();
  expect(calls.map(([, ...args]) => args[0])).toEqual(["config"]);
});

test("a git query that fails blocks only history rewrites, with the reason", () => {
  const broken = () => {
    throw new Error("spawnSync git ETIMEDOUT");
  };
  expect(findViolation("git push --force-with-lease=feature:abc123", "/repo", broken)).toContain("ETIMEDOUT");
  expect(findViolation("git push --force-with-lease=feature:abc123 origin feature", "/repo", broken)).toContain("ETIMEDOUT");
  expect(findViolation("git push origin feature", "/repo", broken)).toBeUndefined();
  expect(findViolation("git push", "/repo", broken)).toBeUndefined();
});

test("a push over ssh reads no local repository and is judged by its refspecs", () => {
  const calls = [];
  const git = fakeGit({ config: "remote.origin.push +HEAD:main", calls });
  for (const command of ["ssh host 'cd /other && git push'", "ssh host git -C /other push", "ssh host 'git push origin feature'",
    "ssh host 'cd ~/.config && git reset --hard'"]) {
    expect(findViolation(command, "/repo", git)).toBeUndefined();
  }
  expect(calls).toEqual([]);
  expect(findViolation("ssh host git -C /repo push --force origin main", "/repo", git)).toContain("a default branch");
  // the branch a remote bare lease rewrites is unknown here
  expect(findViolation("ssh host 'cd /repo && git push --force-with-lease=x:abc123'", "/repo", git)).toContain("could not be determined");
  expect(calls).toEqual([]);
});

describe("a cd in a subshell, a background job or an earlier pipeline part moves no later push", () => {
  const push = "git push --force-with-lease=trunk:abc origin trunk";
  const trunkIn = (dir, calls) => fakeGit({ remoteHead: { [dir]: "origin/trunk" }, calls });

  test.each([[`(cd /tmp); ${push}`], [`cd /tmp & ${push}`], [`cd /tmp | true; ${push}`]])(
    "%s is checked in the session's directory",
    (command) => {
      expect(findViolation(command, "/repo", trunkIn("/repo"))).toContain("trunk");
      expect(findViolation(command, "/repo", trunkIn("/tmp"))).toBeUndefined();
    },
  );

  // zsh runs a pipeline's last part in the current shell, so its cd moves later commands
  test.each([[`(cd /tmp; ${push})`], [`true | cd /tmp; ${push}`]])("%s is checked in /tmp", (command) => {
    const calls = [];
    expect(findViolation(command, "/repo", trunkIn("/repo", calls))).toBeUndefined();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([dir]) => dir === "/tmp")).toBe(true);
    expect(findViolation(command, "/repo", trunkIn("/tmp"))).toContain("trunk");
  });
});

test("a word the shell fills in is named in the reason", () => {
  expect(verdict("git push origin $(cat refspec)")).toContain("`$(cat refspec)`");
});

test("a script nested too deeply to check is blocked", () => {
  let command = "git status";
  for (let i = 0; i < 10; i++) command = `bash -c ${JSON.stringify(command)}`;
  expect(verdict(command)).toContain("too deeply");
});

describe("hook process", () => {
  let root;
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const git = (cwd, ...args) => {
    const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, env });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  const run = (stdin) => {
    const result = Bun.spawnSync({ cmd: [process.execPath, HOOK], stdin: Buffer.from(stdin), env });
    return { code: result.exitCode, stderr: result.stderr.toString() };
  };
  const bash = (command, cwd) => run(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd }));

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "guard-git-push-"));
    git(root, "init", "-q", "--bare", "-b", "main", "remote.git");
    git(root, "init", "-q", "-b", "main", "work");
    const work = join(root, "work");
    git(work, "commit", "-q", "--allow-empty", "-m", "initial");
    git(work, "remote", "add", "origin", join(root, "remote.git"));
    git(work, "push", "-q", "-u", "origin", "main");
    git(work, "switch", "-q", "-c", "feature");
    git(work, "push", "-q", "-u", "origin", "feature");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("blocks a bare force push from the default branch", () => {
    const work = join(root, "work");
    git(work, "switch", "-q", "main");
    const result = bash("git push --force", work);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("main, a default branch");
  });

  // Codex sends its exec_command calls as tool_name Bash with the command string and the
  // call's workdir as cwd, plus fields Claude Code does not send.
  test("blocks a force push to main in Codex-shaped input", () => {
    const work = join(root, "work");
    git(work, "switch", "-q", "feature");
    const result = run(JSON.stringify({
      session_id: "s", turn_id: "t", tool_use_id: "call_1", transcript_path: null, cwd: work, hook_event_name: "PreToolUse",
      model: "gpt-5.5", permission_mode: "default", tool_name: "Bash", tool_input: { command: "git push --force origin main" },
    }));
    expect(result.code).toBe(2);
    expect(result.stderr).toStartWith("Blocked by the guard-git-push hook:");
  });

  test.each([
    ["function f { git push --force origin main; }; f"],
    ["function f() { git push --force origin main; }; f"],
  ])("blocks a force push inside a function body: %s", (command) => {
    expect(bash(command, join(root, "work")).code).toBe(2);
  });

  // The entry point's text prefilter must not skip an alias command without the word "push".
  test.each([
    ["git --config-env=alias.p=V p --force origin main"],
    ["git -c alias.p=$CMD p origin main"],
    [`git -c al"ias".p=-p p origin main`],
  ])("blocks an alias it cannot read: %s", (command) => {
    const result = bash(command, join(root, "work"));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("alias the guard cannot read");
  });

  // macOS volumes ignore case, and the shell removes quotes and backslashes, so each of these runs git (dotfiles-168).
  test.each([
    ["GIT push --force origin main"],
    ["Git push -f origin main"],
    [`g"i"t push --force origin main`],
    ["g\\it push --force origin main"],
    ["gi''t push --force origin main"],
  ])("blocks a force push to main by another spelling of git: %s", (command) => {
    const result = bash(command, join(root, "work"));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("main, a default branch");
  });

  test("allows a push to a feature branch by another spelling of git", () => {
    expect(bash("GIT push --dry-run origin feature", join(root, "work"))).toEqual({ code: 0, stderr: "" });
  });

  test("allows an alias for a command that does not push", () => {
    expect(bash("git -c alias.st=status st", join(root, "work")).code).toBe(0);
  });

  test("follows cd into another checkout", () => {
    git(join(root, "work"), "switch", "-q", "main");
    const result = bash(`cd ${join(root, "work")} && git push --force-with-lease=main:0000000`, root);
    expect(result.code).toBe(2);
  });

  test("allows an explicit lease on a feature branch", () => {
    const work = join(root, "work");
    git(work, "switch", "-q", "feature");
    const sha = git(work, "rev-parse", "HEAD");
    expect(bash(`git push --force-with-lease=feature:${sha} origin feature`, work)).toEqual({ code: 0, stderr: "" });
  });

  test("blocks a plain push whose configured push refspec force-pushes the default branch", () => {
    const work = join(root, "work");
    git(work, "switch", "-q", "feature");
    git(work, "config", "remote.origin.push", "+refs/heads/feature:refs/heads/main");
    try {
      const result = bash("git push", work);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("main, a default branch");
    } finally {
      git(work, "config", "--unset-all", "remote.origin.push");
    }
    expect(bash("git push", work)).toEqual({ code: 0, stderr: "" });
  });

  test("blocks a plain push to a remote configured to mirror", () => {
    const work = join(root, "work");
    git(work, "config", "remote.origin.mirror", "true");
    try {
      expect(bash("git push", work).stderr).toContain("every branch, including the default branch");
    } finally {
      git(work, "config", "--unset", "remote.origin.mirror");
    }
  });

  test("ignores other commands and tools", () => {
    expect(bash("ls -la", root)).toEqual({ code: 0, stderr: "" });
    expect(run(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } }))).toEqual({ code: 0, stderr: "" });
  });

  test("fails open on malformed input", () => {
    const result = run("not json");
    expect(result.code).not.toBe(0);
    expect(result.code).not.toBe(2);
  });
});

describe("pushes xargs supplies or extends (dotfiles-338)", () => {
  // Over ssh, the guard judges a push by its words (dotfiles-333), so words xargs adds block it there too.
  test.each([
    ["echo --force | xargs git push origin main", "xargs adds arguments"],
    ["echo origin | xargs git push --dry-run", "xargs adds arguments"],
    ["echo 'push -f origin main' | xargs git", "xargs adds arguments"],
    ["echo --force | xargs ssh host git push origin main", "xargs adds arguments"],
    ["echo 'git push -f origin main' | xargs sudo", "xargs runs the words it reads"],
    ["echo '; git push -f origin main' | xargs ssh host true", "xargs runs the words it reads"],
    ["echo +main | xargs -I{} sh -c 'git push origin {}'", "the shell fills in `${xargs}`"],
    ["echo push | xargs -I{} git {} -f origin main", "the shell fills in the git subcommand"],
  ])("blocks %s", (command, reason) => {
    expect(verdict(command)).toContain(reason);
  });

  test.each([["git ls-files | xargs grep foo"], ["ls | xargs -n1 basename"], ["find . -name x | xargs rm -f"], ["git branch --merged | xargs git branch -d"], ["find . -name x | xargs -I{} rm -f {}"]])("allows %s", (command) => {
    expect(verdict(command)).toBeUndefined();
  });
});

describe("an alias set on the command line (dotfiles-278)", () => {
  test.each([
    ["git -c alias.p=push p --force origin main", "default branch"],
    ["git -c alias.P=push P --force origin main", "default branch"],
    [`git -c alias.p='"push" --force' p origin main`, "alias the guard cannot read"],
    ["git -c 'alias.p=push --force' p origin main", "default branch"],
    ["git -c alias.q=push -c alias.p=q p --force origin main", "default branch"],
    ["git --config-env=alias.p=V p --force origin main", "alias the guard cannot read"],
    ["git --config-env alias.p=V p --force origin main", "alias the guard cannot read"],
    ["git -c 'alias.p=!git push --force origin main' p", "alias the guard cannot read"],
    ["git -c alias.p=$CMD p origin main", "alias the guard cannot read"],
    ["git -c alias.p=p p origin main", "alias the guard cannot read"],
    ["git -c alias.p=-p p origin main", "alias the guard cannot read"],
    // git takes the last value of a key
    ["git -c alias.p=status -c alias.p=push p --force origin main", "default branch"],
    // an alias never hides a built-in command
    ["git -c alias.push=status push --force origin main", "default branch"],
  ])("blocks %s", (command, reason) => {
    expect(verdict(command)).toContain(reason);
  });
  test.each([
    ["git -c alias.p=push p origin feature"],
    ["git -c alias.st=status st"],
    ["git -c alias.p=push status --force origin main"],
  ])("allows %s", (command) => {
    expect(verdict(command)).toBeUndefined();
  });
});

describe("git in any case, as macOS volumes ignore case (dotfiles-168)", () => {
  test.each([
    ["GIT push --force origin main"],
    ["Git push -f origin main"],
    ["/usr/bin/GIT push -f origin main"],
    ["GIT -C /other push --force"],
  ])("blocks %s", (command) => {
    expect(verdict(command)).toBeDefined();
  });

  test.each([
    ["GIT push origin feature"],
    ["Git status"],
  ])("allows %s", (command) => {
    expect(verdict(command)).toBeUndefined();
  });
});

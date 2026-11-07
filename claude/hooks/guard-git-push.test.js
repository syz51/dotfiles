import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findViolation } from "./guard-git-push.js";

const HOOK = join(import.meta.dir, "guard-git-push.js");

// Checkouts by directory: /repo is on `feature`, /other is on `main`; both push to
// origin/<branch>, and origin/HEAD is `remoteHead`. `config` is what `git config --get-regexp`
// prints. `calls` records every query.
function fakeGit({ branch = "feature", remoteHead = "origin/main", config, calls = [] } = {}) {
  const branches = { "/repo": branch, "/other": "main" };
  return (dir, args) => {
    calls.push([dir, ...args]);
    if (args[0] === "config") return config;
    const query = args.join(" ");
    if (query === "symbolic-ref --quiet --short HEAD") return branches[dir];
    if (query === "rev-parse --abbrev-ref --symbolic-full-name @{push}") return branches[dir] && `origin/${branches[dir]}`;
    if (query.startsWith("symbolic-ref --quiet --short refs/remotes/")) return remoteHead;
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
    ['git push --dry-run origin "$REF"'],
    ['echo "$(git push origin feature)"'],
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

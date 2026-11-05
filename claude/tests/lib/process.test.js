import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv, runProcess } from "./process.js";

const bun = process.execPath;

test("childEnv drops parent-session variables and keeps the rest", () => {
  const env = childEnv({
    PATH: "/bin", HOME: "/home/a", ANTHROPIC_API_KEY: "kept",
    CLAUDECODE: "1", CLAUDE_EFFORT: "medium", CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDE_CODE_SESSION_ID: "x",
    CLAUDE_CODE_MESSAGING_TOKEN: "t", CLAUDE_PID: "1", AI_AGENT: "claude-code", T3CODE_THREAD_ID: "y",
    CLAUDE_EFFORTLESS_NAME_LIKE: "dropped too", NOT_CLAUDE_X: "kept",
  }, { CLAUDE_CODE_TMPDIR: "/tmp/root", TMPDIR: "/tmp/root" });
  expect(env).toEqual({
    PATH: "/bin", HOME: "/home/a", ANTHROPIC_API_KEY: "kept", NOT_CLAUDE_X: "kept",
    CLAUDE_CODE_TMPDIR: "/tmp/root", TMPDIR: "/tmp/root",
  });
});

test("output keeps UTF-8 characters split across byte-sized chunks", async () => {
  const code = 'const b=Buffer.from("明日の会議\\n中文意思");let i=0;const t=setInterval(()=>{process.stdout.write(b.subarray(i,i+1));if(++i===b.length)clearInterval(t)},2)';
  const result = await runProcess([bun, "-e", code]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("明日の会議\n中文意思");
});

test("exit codes, empty output and spawn errors are reported without hanging", async () => {
  expect((await runProcess([bun, "-e", "process.exit(7)"])).code).toBe(7);
  const empty = await runProcess([bun, "-e", "void 0"]);
  expect([empty.code, empty.stdout, empty.stderr]).toEqual([0, "", ""]);
  await expect(runProcess(["/nonexistent-test-executable"])).rejects.toThrow();
});

test("input goes to stdin; a child that ignores it still exits cleanly", async () => {
  const echoed = await runProcess([bun, "-e", "process.stdin.pipe(process.stdout)"], { input: "через stdin 中文\n" });
  expect(echoed.stdout).toBe("через stdin 中文\n");
  const ignored = await runProcess([bun, "-e", "process.exit(3)"], { input: "x".repeat(1024 * 1024) });
  expect(ignored.code).toBe(3);
  const closed = await runProcess([bun, "-e", 'let n=0;process.stdin.on("data",(c)=>n+=c.length).on("end",()=>console.log(n))']);
  expect(closed.stdout.trim()).toBe("0");
});

test("a timeout also kills descendants that started their own process group", async () => {
  const root = mkdtempSync(join(tmpdir(), "process-test-"));
  const pidFile = join(root, "pid");
  let pid;
  try {
    // The child starts a detached grandchild (its own group, like a nested runProcess)
    // and stays alive itself, so the grandchild is still its descendant at the deadline.
    const code = `const {spawn}=require("node:child_process");const fs=require("node:fs");`
      + `const c=spawn(${JSON.stringify(bun)},["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});`
      + `fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`;
    const error = await runProcess([bun, "-e", code], { timeout: 700 }).catch((e) => e);
    expect(error.message).toContain("timeout");
    pid = Number(readFileSync(pidFile, "utf8"));
    await Bun.sleep(150);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) expect((await runProcess(["ps", "-o", "stat=", "-p", String(pid)])).stdout.trim()).toMatch(/^Z/);
  } finally {
    if (pid) try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("stdout and stderr share one output bound", async () => {
  await expect(runProcess([bun, "-e", 'process.stdout.write("a".repeat(400));process.stderr.write("b".repeat(400))'], { maxBytes: 500 }))
    .rejects.toThrow("bound");
});

test("a timeout keeps the partial output and kills descendants after the leader exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "process-test-"));
  const pidFile = join(root, "pid");
  let pid;
  try {
    const code = `const {spawn}=require("node:child_process");const fs=require("node:fs");console.log("partial");`
      + `const c=spawn(${JSON.stringify(bun)},["-e","setInterval(()=>{},1000)"],{stdio:["ignore",1,2]});`
      + `fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();`;
    const error = await runProcess([bun, "-e", code], { timeout: 500 }).catch((e) => e);
    expect(error.message).toContain("timeout");
    expect(error.stdout).toContain("partial");
    pid = Number(readFileSync(pidFile, "utf8"));
    await Bun.sleep(100);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) expect((await runProcess(["ps", "-o", "stat=", "-p", String(pid)])).stdout.trim()).toMatch(/^Z/);
  } finally {
    if (pid) try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

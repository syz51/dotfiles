import { test, expect } from "bun:test";
import { boundedProcess } from "./lib/process.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("process capture preserves UTF-8 across byte-sized chunks", async () => {
  const code =
    'const b=Buffer.from("明日の会議\\n中文意思"); let i=0; const t=setInterval(()=>{process.stdout.write(b.subarray(i,i+1));if(++i===b.length)clearInterval(t)},2)';
  const r = await boundedProcess(["bun", "-e", code]);
  expect(r.code).toBe(0);
  expect(r.out).toBe("明日の会議\n中文意思");
});
test("spawn errors and empty stdout do not hang", async () => {
  await expect(
    boundedProcess(["/nonexistent-test-executable"]),
  ).rejects.toThrow();
  const r = await boundedProcess(["bun", "-e", "void 0"]);
  expect(r).toEqual({ code: 0, out: "", err: "" });
});
test("stdout and stderr share one output bound", async () => {
  await expect(
    boundedProcess(
      [
        "bun",
        "-e",
        'process.stdout.write("a".repeat(400));process.stderr.write("b".repeat(400));',
      ],
      { maxBytes: 500 },
    ),
  ).rejects.toThrow("bound");
});
test("timeout kills descendants even after the leader exits", async () => {
  const root = await mkdtemp(
    join(process.env.TMPDIR || tmpdir(), "process-test-"),
  );
  const path = join(root, "pid");
  let pid;
  try {
    const code = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn('bun',['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});fs.writeFileSync(${JSON.stringify(path)},String(child.pid));child.unref();`;
    await expect(
      boundedProcess(["bun", "-e", code], { timeout: 300 }),
    ).rejects.toThrow("timeout");
    pid = Number(await readFile(path, "utf8"));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      const state = await boundedProcess([
        "ps",
        "-o",
        "stat=",
        "-p",
        String(pid),
      ]);
      expect(state.out.trim()).toMatch(/^Z/);
    }
  } finally {
    if (pid)
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

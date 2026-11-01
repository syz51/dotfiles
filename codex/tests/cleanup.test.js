import { test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readdir,
  readFile,
  rm,
  chmod,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { boundedProcess } from "./lib/process.js";
const suite = fileURLToPath(new URL("./explorer.test.js", import.meta.url));
for (const mode of [
  "exit7",
  "malformed",
  "incomplete",
  "timeout",
  "report-io",
  "truncated-exit",
  "truncated-timeout",
  "invalid-report",
])
  test(`full fake CLI ${mode} removes only proven owned transcripts`, async () => {
    const root = await mkdtemp(
      join(process.env.TMPDIR || tmpdir(), "cleanup-test-"),
    );
    try {
      const home = join(root, "home"),
        sessions = join(home, ".codex/sessions"),
        bin = join(root, "bin");
      await mkdir(sessions, { recursive: true });
      await mkdir(bin);
      await writeFile(join(home, ".codex/AGENTS.md"), "# Synthetic defaults\n");
      await writeFile(join(sessions, "existing.jsonl"), "preserved existing\n");
      const script = `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const sessions=path.join(process.env.HOME,'.codex/sessions');const meta=(id,cwd,source)=>JSON.stringify({type:'session_meta',payload:{id,cwd,source}})+'\\n';fs.writeFileSync(path.join(sessions,'parent.jsonl'),meta('owned-parent',process.cwd(),'cli'));fs.writeFileSync(path.join(sessions,'child.jsonl'),meta('owned-child',process.cwd(),{subagent:{thread_spawn:{parent_thread_id:'owned-parent'}}}));fs.writeFileSync(path.join(sessions,'unrelated.jsonl'),meta('other','/unrelated','cli'));fs.writeFileSync(path.join(sessions,'uncertain.jsonl'),'{bad');if(process.env.FAKE_MODE.startsWith('truncated-'))fs.appendFileSync(path.join(sessions,'parent.jsonl'),'{bad');if(['exit7','report-io','truncated-exit'].includes(process.env.FAKE_MODE))process.exit(7);if(process.env.FAKE_MODE==='malformed'){console.log('{bad');process.exit(0);}if(process.env.FAKE_MODE==='incomplete'){console.log(JSON.stringify({type:'thread.started',thread_id:'owned-parent'}));process.exit(0);}setTimeout(()=>{},60000);\n`;
      await writeFile(join(bin, "codex"), script);
      await chmod(join(bin, "codex"), 0o755);
      const reports = join(root, "reports");
      await mkdir(reports);
      if (mode === "report-io")
        await mkdir(
          join(reports, "multi-file-codebase-exploration.trace.jsonl"),
        );
      if (mode === "invalid-report")
        await writeFile(join(root, "not-a-directory"), "preserve");
      const run = await boundedProcess(
        [
          process.execPath,
          "test",
          suite,
          "-t",
          "live: multi-file codebase exploration",
        ],
        {
          cwd: dirname(dirname(dirname(suite))),
          env: {
            ...process.env,
            HOME: home,
            PATH: bin + ":" + process.env.PATH,
            TMPDIR: root,
            RUN_CODEX_EXPLORER_LIVE: "1",
            RUN_CODEX_DELEGATION_CONTRACT_LIVE: "0",
            CODEX_EVAL_TIMEOUT_MS: ["timeout", "truncated-timeout"].includes(
              mode,
            )
              ? "500"
              : "2000",
            FAKE_MODE: mode,
            CODEX_EVAL_REPORT_DIR:
              mode === "invalid-report"
                ? join(root, "not-a-directory")
                : reports,
          },
          timeout: 10000,
        },
      );
      expect(run.code, "Fake failure must not pass live assertions").not.toBe(
        0,
      );
      if (mode === "invalid-report") {
        expect(await readdir(sessions)).toEqual(["existing.jsonl"]);
        expect(
          (await readdir(root)).some((n) =>
            n.startsWith("codex-explorer-test-"),
          ),
        ).toBe(false);
        return;
      }
      if (mode !== "report-io") {
        const report = JSON.parse(
          await readFile(
            join(reports, "multi-file-codebase-exploration.json"),
            "utf8",
          ),
        );
        expect(report.status).toBe("failed");
        expect(report.passed).toBe(false);
      }
      expect((await readdir(sessions)).sort(), run.err).toEqual([
        "existing.jsonl",
        "uncertain.jsonl",
        "unrelated.jsonl",
      ]);
      expect(await readFile(join(sessions, "existing.jsonl"), "utf8")).toBe(
        "preserved existing\n",
      );
      expect(await readFile(join(sessions, "uncertain.jsonl"), "utf8")).toBe(
        "{bad",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);

test("full fake archive CLI cannot pass with an unauthorized same-byte symlink", async () => {
  const root = await mkdtemp(
    join(process.env.TMPDIR || tmpdir(), "symlink-cli-test-"),
  );
  try {
    const home = join(root, "home"),
      sessions = join(home, ".codex/sessions"),
      bin = join(root, "bin");
    await mkdir(sessions, { recursive: true });
    await mkdir(bin);
    await writeFile(join(home, ".codex/AGENTS.md"), "# Synthetic defaults\n");
    const outside = join(root, "outside-preserve.md");
    const script = `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const sessions=path.join(process.env.HOME,'.codex/sessions'),cwd=process.cwd();const record=(type,payload)=>JSON.stringify({type,payload})+'\\n';const meta={id:'p',cwd,source:'cli'};const parent=record('session_meta',meta)+record('response_item',{type:'message',role:'user',content:[{text:'# Synthetic defaults\\n'}]})+record('response_item',{type:'function_call',name:'spawn_agent',arguments:'{"agent_type":"worker"}'});fs.writeFileSync(path.join(sessions,'p.jsonl'),parent+record('turn_context',{turn_id:'parent-current',model:'gpt-6.1-sol',effort:'xhigh'})+record('event_msg',{type:'task_started',turn_id:'parent-current'})+record('event_msg',{type:'task_complete',turn_id:'parent-current'}));fs.writeFileSync(path.join(sessions,'c.jsonl'),record('session_meta',{id:'c',cwd,agent_role:'worker',source:{subagent:{thread_spawn:{parent_thread_id:'p'}}}})+record('turn_context',{turn_id:'worker-current',model:'gpt-6.1-sol',effort:'medium'})+record('event_msg',{type:'task_started',turn_id:'worker-current'})+record('event_msg',{type:'task_complete',turn_id:'worker-current'}));const text='\\n2026-10-28 OBS-028 18 15 3 PROP-029 proposed, not adopted; current direction unchanged. verified-facts.md:2 verified-facts.md:4 decisions/current.md REF-002 Synthetic audit sheet 2026-10-28 supports OBS-028.\\n';for(const name of ['topics/evidence.md','research-log.md','references.md'])fs.appendFileSync(name,text);const data=fs.readFileSync('verified-facts.md');fs.writeFileSync(${JSON.stringify(outside)},data);fs.unlinkSync('verified-facts.md');fs.symlinkSync(${JSON.stringify(outside)},'verified-facts.md');for(const e of [{type:'thread.started',thread_id:'p'},{type:'item.completed',item:{type:'agent_message',text:'Updated topics/evidence.md research-log.md references.md OBS-028 PROP-029'}},{type:'turn.completed'}])console.log(JSON.stringify(e));\n`;
    await writeFile(join(bin, "codex"), script);
    await chmod(join(bin, "codex"), 0o755);
    const run = await boundedProcess(
      [
        process.execPath,
        "test",
        suite,
        "-t",
        "live: authorized archive update",
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          PATH: bin + ":" + process.env.PATH,
          TMPDIR: root,
          RUN_CODEX_EXPLORER_LIVE: "1",
          RUN_CODEX_DELEGATION_CONTRACT_LIVE: "0",
          CODEX_EVAL_TIMEOUT_MS: "2000",
          CODEX_EVAL_REPORT_DIR: join(root, "reports"),
        },
        timeout: 10000,
      },
    );
    expect(run.code).not.toBe(0);
    expect(run.err).toContain("Unexpected fixture symlink");
    const report = JSON.parse(
      await readFile(
        join(
          root,
          "reports/authorized-archive-update-from-verified-facts.json",
        ),
        "utf8",
      ),
    );
    expect(report.status).toBe("failed");
    expect(report.passed).toBe(false);
    expect(await readFile(outside, "utf8")).toContain("OBS-028");
    expect(await readdir(sessions)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

for (const mode of ["report-io", "invalid-report"])
  test(`policy ${mode} cannot skip fixture or owned transcript cleanup`, async () => {
    const root = await mkdtemp(
      join(process.env.TMPDIR || tmpdir(), "policy-io-test-"),
    );
    try {
      const home = join(root, "home"),
        sessions = join(home, ".codex/sessions"),
        bin = join(root, "bin"),
        reports = join(root, "reports");
      await mkdir(sessions, { recursive: true });
      await mkdir(bin);
      await mkdir(reports);
      await writeFile(join(home, ".codex/AGENTS.md"), "# Synthetic defaults\n");
      await writeFile(join(sessions, "existing.jsonl"), "existing preserved");
      if (mode === "report-io")
        await mkdir(join(reports, "python-fix.trace.jsonl"));
      else await writeFile(join(root, "not-directory"), "preserve");
      const script = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const sessions = path.join(process.env.HOME, '.codex/sessions');
const record = {type: 'session_meta', payload: {id: 'p', cwd: process.cwd(), source: 'cli'}};
fs.writeFileSync(path.join(sessions, 'p.jsonl'), JSON.stringify(record)+'\\n');
process.exit(7);
`;
      await writeFile(join(bin, "codex"), script);
      await chmod(join(bin, "codex"), 0o755);
      const policy = fileURLToPath(
        new URL("./policy.test.js", import.meta.url),
      );
      const run = await boundedProcess(
        [process.execPath, "test", policy, "-t", "policy live: python-fix"],
        {
          env: {
            ...process.env,
            HOME: home,
            PATH: bin + ":" + process.env.PATH,
            TMPDIR: root,
            RUN_CODEX_POLICY_LIVE: "1",
            CODEX_EVAL_REPORT_DIR:
              mode === "report-io" ? reports : join(root, "not-directory"),
          },
          timeout: 10000,
        },
      );
      expect(run.code).not.toBe(0);
      expect(await readdir(sessions)).toEqual(["existing.jsonl"]);
      expect(
        (await readdir(root)).some((n) => n.startsWith("agents-policy-")),
      ).toBe(false);
      expect(await readFile(join(sessions, "existing.jsonl"), "utf8")).toBe(
        "existing preserved",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);

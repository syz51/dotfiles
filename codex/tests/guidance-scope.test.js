import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  copyFile,
  chmod,
  rm,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { boundedProcess } from "./lib/process.js";

const installedEngine = join(
  homedir(),
  ".local/share/codex-skills/repository/scripts",
);
const engineFiles = ["activation_trace.py", "read_guidance.py"];
const integration = engineFiles.every((name) =>
  existsSync(join(installedEngine, name)),
)
  ? test
  : test.skip;
const policy = fileURLToPath(new URL("./policy.test.js", import.meta.url));

integration(
  "whole-run guidance scope rejects an actual forbidden read in a linked descendant",
  async () => {
    const root = await mkdtemp(
      join(process.env.TMPDIR || tmpdir(), "guidance-scope-"),
    );
    try {
      const home = join(root, "home"),
        sessions = join(home, ".codex/sessions"),
        bin = join(root, "bin"),
        reports = join(root, "reports"),
        defaults =
          "# Synthetic defaults\nRead applicable guidance before chart advice.\n",
        frontend = "# Frontend UI\nUse accessible plain markup.\n",
        preferences =
          "# Personal visual preferences\nAvoid rainbow gradients.\n",
        visualization =
          "# Data visualization\nPrefer an accessible bar chart.\n",
        typescript =
          "# TypeScript\nUse validated types at the owning boundary.\n";
      const specs = [
        [".codex/AGENTS.md", defaults],
        [".codex/skills/frontend-ui/SKILL.md", frontend],
        [".codex/frontend-avoid.md", preferences],
        [".codex/skills/typescript/SKILL.md", typescript],
        [
          ".codex/plugins/cache/openai-bundled/visualize/1.0.0/skills/visualize/SKILL.md",
          visualization,
        ],
      ];
      await mkdir(sessions, { recursive: true });
      await mkdir(bin);
      for (const [name, content] of specs) {
        await mkdir(dirname(join(home, name)), { recursive: true });
        await writeFile(join(home, name), content);
      }
      const engine = join(home, ".local/share/codex-skills/repository/scripts");
      await mkdir(engine, { recursive: true });
      for (const name of engineFiles)
        await copyFile(join(installedEngine, name), join(engine, name));
      await writeFile(join(sessions, "existing.jsonl"), "existing preserved\n");
      const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const home = process.env.HOME;
const cwd = fs.realpathSync(process.cwd());
const sessions = path.join(home,'.codex/sessions');
const record = (type,payload) => ({type,payload});
const phase = (id,turn,source) => [
  record('session_meta',{id,cwd,source}),
  record('turn_context',{turn_id:turn,model:'gpt-6.1-sol',effort:'xhigh'}),
  record('event_msg',{type:'task_started',turn_id:turn}),
];
const terminal = turn => record('event_msg',{type:'task_complete',turn_id:turn});
const runtime = (thread,turn,id,command,output,code) => record('event_msg',{
  type:'item_completed',thread_id:thread,turn_id:turn,
  item:{type:'CommandExecution',id,command,cwd:pathToFileURL(cwd).href,
    status:code === 0 ? 'completed' : 'failed',exit_code:code,aggregated_output:output},
});
const read = file => {
  const command = ['/bin/cat',file];
  const result = spawnSync(command[0],command.slice(1),{cwd,encoding:'utf8',timeout:10000});
  if(result.error) throw result.error;
  if(result.status !== 0) throw Error(result.stderr);
  return {command,output:result.stdout+result.stderr,code:result.status};
};
const parent = phase('owned-parent','parent-current','cli');
parent.splice(1,0,record('response_item',{type:'message',role:'user',content:[{
  type:'input_text',text:fs.readFileSync(path.join(home,'.codex/AGENTS.md'),'utf8'),
}]}));
const cli = [{type:'thread.started',thread_id:'owned-parent'},{type:'turn.started'}];
const rootReads = [
  '.codex/skills/frontend-ui/SKILL.md',
  '.codex/frontend-avoid.md',
  '.codex/plugins/cache/openai-bundled/visualize/1.0.0/skills/visualize/SKILL.md',
];
for(const [index,name] of rootReads.entries()) {
  const actual = read(path.join(home,name));
  const id = 'root-exec-'+index;
  parent.push(runtime('owned-parent','parent-current',id,actual.command,actual.output,actual.code));
  cli.push({type:'item.completed',item:{type:'command_execution',id,
    command:actual.command.map(word=>JSON.stringify(word)).join(' '),
    exit_code:actual.code,aggregated_output:actual.output}});
}
parent.push(record('response_item',{type:'function_call',name:'spawn_agent',call_id:'spawn-child',
  arguments:JSON.stringify({agent_type:'explorer',message:'Inspect the local fixture.'})}));
const child = phase('owned-child','child-current',{
  subagent:{thread_spawn:{parent_thread_id:'owned-parent'}},
});
child[0].payload.agent_role = 'explorer';
const actual = read(path.join(home,'.codex/skills/typescript/SKILL.md'));
child.push(record('response_item',{type:'custom_tool_call',name:'exec',call_id:'child-exec-tool',
  input:'text(await tools.exec_command('+JSON.stringify({cmd:actual.command.map(word=>JSON.stringify(word)).join(' ')})+'));'}));
child.push(runtime('owned-child','child-current','child-exec',actual.command,actual.output,actual.code));
child.push(record('response_item',{type:'custom_tool_call_output',call_id:'child-exec-tool',output:actual.output}));
child.push(terminal('child-current'));
parent.push(terminal('parent-current'));
for(const [name,records] of [['owned-parent.jsonl',parent],['owned-child.jsonl',child]])
  fs.writeFileSync(path.join(sessions,name),records.map(JSON.stringify).join('\\n')+'\\n');
fs.writeFileSync(path.join(sessions,'unrelated.jsonl'),JSON.stringify(record('session_meta',{
  id:'unrelated',cwd:'/unrelated',source:'cli',
}))+'\\n');
cli.push({type:'item.completed',item:{type:'agent_message',text:'Use an accessible bar chart in a quiet visual direction.'}});
cli.push({type:'turn.completed'});
for(const event of cli) console.log(JSON.stringify(event));
`;
      await writeFile(join(bin, "codex"), script);
      await chmod(join(bin, "codex"), 0o755);
      const run = await boundedProcess(
        [
          process.execPath,
          "test",
          policy,
          "-t",
          "policy live: visual-direction-routing",
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            CODEX_HOME: join(home, ".codex"),
            PATH: bin + ":" + process.env.PATH,
            TMPDIR: root,
            UV_OFFLINE: "1",
            UV_NO_CACHE: "1",
            UV_PYTHON_DOWNLOADS: "never",
            RUN_CODEX_POLICY_LIVE: "1",
            CODEX_EVAL_REPORT_DIR: reports,
          },
          timeout: 45000,
        },
      );
      expect(run.code).not.toBe(0);
      const forbidden = "Descendant: Forbidden guidance was read: typescript";
      expect(run.err).toContain(forbidden);
      const report = JSON.parse(
        await readFile(join(reports, "visual-direction-routing.json"), "utf8"),
      );
      expect(report.status).toBe("failed");
      expect(report.passed).toBe(false);
      expect(report.loadedInstructions).toBe(true);
      expect(report.turnCompleted).toBe(true);
      expect(report.sourceCount).toBe(2);
      expect(report.error).toContain(forbidden);
      for (const target of ["frontend-ui", "preferences", "visualize"])
        expect(
          report.guidanceResult.result.reads.some(
            (read) => read.target === target && read.coverage === "complete",
          ),
        ).toBe(true);
      expect(
        report.guidanceResult.result.failures.some((failure) =>
          failure.startsWith("Complete content was not observed:"),
        ),
      ).toBe(false);
      expect(report.guidanceResult.result.failures).toContain(forbidden);
      expect(
        report.guidanceResult.descendantEvidence[0].runtimeView.completed,
      ).toBe(true);
      expect(
        report.guidanceResult.descendantEvidence[0].runtimeView.unmodeledTools
          .length,
      ).toBeGreaterThan(0);
      expect(report.commands).toHaveLength(3);
      expect(
        report.commands.every(
          (command) => !command.command.includes("/typescript/"),
        ),
      ).toBe(true);
      const raw = (await readdir(reports)).filter((name) =>
        name.startsWith("visual-direction-routing.owned-source-"),
      );
      expect(raw).toHaveLength(2);
      const sources = await Promise.all(
        raw.map(async (name) =>
          (await readFile(join(reports, name), "utf8"))
            .trim()
            .split("\n")
            .map(JSON.parse),
        ),
      );
      const child = sources.find(
        (records) => records[0].payload.id === "owned-child",
      );
      expect(child).toBeDefined();
      const actualRead = child.find(
        (record) =>
          record.type === "event_msg" &&
          record.payload.type === "item_completed",
      ).payload.item;
      expect(actualRead.command).toEqual([
        "/bin/cat",
        join(home, ".codex/skills/typescript/SKILL.md"),
      ]);
      expect(actualRead.exit_code).toBe(0);
      expect(actualRead.aggregated_output).toBe(typescript);
      expect(
        child.some((record) => record.payload.type === "custom_tool_call"),
      ).toBe(true);
      expect((await readdir(sessions)).sort()).toEqual([
        "existing.jsonl",
        "unrelated.jsonl",
      ]);
      expect(await readFile(join(sessions, "existing.jsonl"), "utf8")).toBe(
        "existing preserved\n",
      );
      expect(
        JSON.parse(await readFile(join(sessions, "unrelated.jsonl"), "utf8"))
          .payload.cwd,
      ).toBe("/unrelated");
      expect(
        (await readdir(root)).some((name) => name.startsWith("agents-policy-")),
      ).toBe(false);
      for (const [name, content] of specs)
        expect(await readFile(join(home, name), "utf8")).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);

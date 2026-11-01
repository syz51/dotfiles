import { test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  chmod,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { boundedProcess } from "./lib/process.js";

const scripts = fileURLToPath(new URL("../scripts", import.meta.url));
const fakeCli = `#!/usr/bin/env python3
import json, os, pathlib, sys
home=pathlib.Path(os.environ['CODEX_HOME'])
root=home/'sessions'; root.mkdir(exist_ok=True)
mode=os.environ['FAKE_MODE']; fixture=sys.argv[sys.argv.index('-C')+1]
def event(kind, **kwargs): return {'type':kind, 'payload':kwargs}
meta=event('session_meta', id='root', cwd=fixture, source='cli')
source=[meta, event('response_item',type='message',role='user',content=[{'type':'input_text','text':(home/'AGENTS.md').read_text()}]),event('turn_context',turn_id='current'),event('event_msg',type='task_started',turn_id='current'),event('event_msg',type='task_complete',turn_id='current')]
if mode=='claim': source[1]['payload']['role']='assistant'
if mode=='old': source[-1]['payload']['turn_id']='old'
if mode=='context': source[2]['payload']['turn_id']='other'
if mode=='failure': source.insert(3,event('event_msg',type='error',turn_id='current'))
if mode=='unscoped-failure': source.insert(3,event('event_msg',type='error'))
if mode=='missing-start': source.pop(3)
if mode=='start-first': source[2],source[3]=source[3],source[2]
if mode=='complete-before-context': source[2],source[4]=source[4],source[2]
if mode=='drift': (home/'AGENTS.md').write_text('changed\\n')
if mode=='malformed-shape': source.append(3)
if mode=='empty-directory': (pathlib.Path(fixture)/'unexpected').mkdir()
if mode=='fixture-mode': (pathlib.Path(fixture)/'input.txt').chmod(0o600)
if mode=='skill-mode': (home.parent/'skill/SKILL.md').chmod(0o600)
if mode=='skill-directory': (home.parent/'skill/unexpected').mkdir()
if mode=='skill-alias-retarget':
    (home.parent/'skill').unlink()
    (home.parent/'skill').symlink_to('skill-b',target_is_directory=True)
if mode in ('delegate','spawn-only'):
    source.append(event('response_item',type='function_call',name='spawn_agent',arguments='{"agent_type":"worker"}'))
if mode=='delegate':
    child=event('session_meta',id='child',cwd=fixture,source={'subagent':{'thread_spawn':{'parent_thread_id':'root'}}})
    grandchild=event('session_meta',id='grandchild',cwd=fixture,source={'subagent':{'thread_spawn':{'parent_thread_id':'child'}}})
    (root/'child.jsonl').write_text(json.dumps(child)+'\\n')
    (root/'grandchild.jsonl').write_text(json.dumps(grandchild)+'\\n{"broken"')
text='\\n'.join(json.dumps(x) for x in source)+'\\n'
if mode=='failed': text+='{"broken"'
(root/'owned.jsonl').write_text(text)
(root/'unrelated.jsonl').write_text(json.dumps(event('session_meta',id='unrelated',cwd='/unrelated'))+'\\n{"broken"')
(root/'unknown.jsonl').write_text('{"broken"')
if mode=='failed':
    child=event('session_meta',id='child',cwd=fixture,source={'subagent':{'thread_spawn':{'parent_thread_id':'root'}}})
    (root/'child.jsonl').write_text(json.dumps(child)+'\\n{"broken"')
    sys.exit(7)
print(json.dumps({'type':'thread.started','thread_id':'root'}))
print(json.dumps({'type':'turn.completed'}))
`;
const harness = `
import hashlib, json, os, pathlib, subprocess, sys, types
sys.path.insert(0,sys.argv[1])
from full_skill_run import run_case
def score(trace,*args,**kwargs):
    result={'passed':True,'completed':True,'reads':[],'failures':[]}
    return {'strictResult':dict(result),'result':result,'attributions':[]}
sys.modules['ordinary_trace']=types.SimpleNamespace(score_ordinary_trace=score)
root=pathlib.Path(sys.argv[2]); home=root/'home'
os.umask(0o022)
if os.environ['FAKE_MODE'].startswith('skill-alias'):
    import shutil
    (root/'skill').rename(root/'skill-a')
    shutil.copytree(root/'skill-a',root/'skill-b')
    (root/'skill').symlink_to('skill-a',target_is_directory=True)
def tree(path):
    return {str(p.relative_to(path)): ('link',os.readlink(p)) if p.is_symlink() else ('file',hashlib.sha256(p.read_bytes()).hexdigest()) for p in path.rglob('*') if p.is_file() or p.is_symlink()}
def process(command,timeout):
    p=subprocess.run(command,capture_output=True,text=True,timeout=timeout)
    return p.returncode,p.stdout,p.stderr,False
engine=types.SimpleNamespace(SAFETY=' Existing canonical safety.',tree_snapshot=tree,snapshot_targets=lambda f:{},run_process=process)
case={'id':'case','invocation':'configured','prompt':'Ordinary prompt','files':{'input.txt':'unchanged\\n'},'required':[],'forbidden':[],'before':[]}
result=run_case(engine,case,root/'out',{'skill':root/'skill'},str(root/'fake-codex'))
print(json.dumps(result))
`;

for (const mode of [
  "valid",
  "claim",
  "old",
  "context",
  "failure",
  "unscoped-failure",
  "missing-start",
  "start-first",
  "complete-before-context",
  "failed",
  "drift",
  "malformed-shape",
  "empty-directory",
  "fixture-mode",
  "skill-mode",
  "skill-directory",
  "delegate",
  "spawn-only",
  "skill-alias-retarget",
  "skill-alias-unchanged",
])
  test(`ordinary skill source evidence and cleanup: ${mode}`, async () => {
    const root = await mkdtemp(
      join(process.env.TMPDIR || tmpdir(), "full-skill-test-"),
    );
    try {
      for (const dir of ["home/sessions", "out", "skill"])
        await mkdir(join(root, dir), { recursive: true });
      await writeFile(
        join(root, "home/AGENTS.md"),
        "exact global instructions\n",
      );
      await writeFile(join(root, "skill/SKILL.md"), "immutable skill\n");
      await chmod(join(root, "skill/SKILL.md"), 0o644);
      const old =
        '{"type":"session_meta","payload":{"id":"old","cwd":"/unrelated"}}\n';
      await writeFile(join(root, "home/sessions/preexisting.jsonl"), old);
      await writeFile(join(root, "fake-codex"), fakeCli);
      await chmod(join(root, "fake-codex"), 0o700);
      const result = await boundedProcess(
        ["uv", "run", "--no-project", "python", "-c", harness, scripts, root],
        {
          env: {
            ...process.env,
            CODEX_HOME: join(root, "home"),
            FAKE_MODE: mode,
            PYTHONDONTWRITEBYTECODE: "1",
          },
          timeout: 30000,
        },
      );
      expect(result.code, result.err).toBe(0);
      const report = JSON.parse(result.out);
      expect(report.passed).toBe(
        ["valid", "start-first", "skill-alias-unchanged"].includes(mode),
      );
      expect(report.ordinaryVerification).toBe(true);
      if (["valid", "start-first", "skill-alias-unchanged"].includes(mode)) {
        expect(report.sourceInput).toBe(true);
        expect(report.currentTurnCompleted).toBe(true);
        expect(report.strictPassed).toBe(true);
      } else expect(report.failures.length).toBeGreaterThan(0);
      expect(
        await readFile(join(root, "home/sessions/preexisting.jsonl"), "utf8"),
      ).toBe(old);
      expect(
        await readFile(join(root, "home/sessions/unrelated.jsonl"), "utf8"),
      ).toContain("/unrelated");
      expect(
        await readFile(join(root, "home/sessions/unknown.jsonl"), "utf8"),
      ).toBe('{"broken"');
      expect(
        await Bun.file(join(root, "home/sessions/owned.jsonl")).exists(),
      ).toBe(false);
      expect(
        await Bun.file(join(root, "home/sessions/child.jsonl")).exists(),
      ).toBe(false);
      expect(
        await Bun.file(join(root, "home/sessions/grandchild.jsonl")).exists(),
      ).toBe(false);
      const saved = await Array.fromAsync(
        new Bun.Glob("source-*.jsonl").scan(join(root, "out/case")),
      );
      expect(saved.length).toBe(
        mode === "delegate" ? 3 : mode === "failed" ? 2 : 1,
      );
      expect(
        JSON.parse(await readFile(join(root, "out/case/result.json"), "utf8")),
      ).toEqual(report);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test("ordinary and controlled dispatch modes are mutually exclusive", async () => {
  const result = await boundedProcess(
    [
      "uv",
      "run",
      "--no-project",
      "python",
      join(scripts, "check_skill_dispatch.py"),
      "--bounded-reads",
      "--ordinary-verification",
      "plan",
    ],
    {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    },
  );
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("not allowed with argument");
});

for (const arg of ["--skills-root", "--skills-root=/tmp/candidate"])
  test(`ordinary dispatch rejects candidate injection before evaluation: ${arg}`, async () => {
    const result = await boundedProcess(
      [
        "uv",
        "run",
        "--no-project",
        "python",
        join(scripts, "check_skill_dispatch.py"),
        "--ordinary-verification",
        "plan",
        arg,
      ],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
    );
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("requires installed user configuration");
  });

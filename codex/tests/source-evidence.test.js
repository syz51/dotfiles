import { test, expect } from "bun:test";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { boundedProcess } from "./lib/process.js";

const scripts = fileURLToPath(new URL("../scripts", import.meta.url));
const program = String.raw`
import copy,json,shlex,sys
sys.path.insert(0,sys.argv[1])
from source_evidence import bind_command_cwds
def rec(kind,**payload): return {'type':kind,'payload':payload}
def command(cwd='file:///actual/override',code=0):
 return rec('event_msg',type='item_completed',thread_id='root',turn_id='current',item={'type':'CommandExecution','id':'exec-one','command':['/bin/zsh','-lc',"cat 'source file.md'"],'cwd':cwd,'status':'completed' if code==0 else 'failed','exit_code':code,'aggregated_output':'policy body\n'})
records=[rec('session_meta',id='root',cwd='/decoy/default',source='cli'),rec('turn_context',turn_id='current'),rec('event_msg',type='task_started',turn_id='current'),command(),rec('event_msg',type='task_complete',turn_id='current')]
item={'id':'item_0','type':'command_execution','command':shlex.join(['/bin/zsh','-lc',"cat 'source file.md'"]),'exit_code':0,'aggregated_output':'policy body\n','status':'completed'}
events=[{'type':'thread.started','thread_id':'root'},{'type':'turn.started'},{'type':'item.completed','item':item},{'type':'turn.completed'}]
def bind(rs=records,es=events): return bind_command_cwds('\n'.join(json.dumps(x) for x in es),rs)
results={}
results['valid']=bind()
for name,cwd in [('percent','file:///actual/space%20and%20%E6%96%87'),('localhost','file://localhost/actual/override'),('root','file:///'),('remote','file://host/actual/override'),('query','file:///actual/override?x=1'),('fragment','file:///actual/override#x'),('relative','file:relative'),('plain','/actual/override'),('bad-percent','file:///actual/%ZZ'),('bad-utf8','file:///actual/%FF'),('traversal','file:///actual/%2E%2E/override'),('nul','file:///actual/%00'),('double-slash','file:////actual/override'),('newline','file:///actual/%0A')]:
 rs=copy.deepcopy(records);rs[3]['payload']['item']['cwd']=cwd;results[name]=bind(rs)
for name,mutate in [
 ('wrong-thread',lambda r:r[3]['payload'].update(thread_id='child')),
 ('wrong-turn',lambda r:r[3]['payload'].update(turn_id='old')),
 ('missing-thread',lambda r:r[3]['payload'].pop('thread_id')),
 ('missing-turn',lambda r:r[3]['payload'].pop('turn_id')),
 ('missing-cwd',lambda r:r[3]['payload']['item'].pop('cwd')),
 ('wrong-output',lambda r:r[3]['payload']['item'].update(aggregated_output='different')),
 ('wrong-command',lambda r:r[3]['payload']['item'].update(command=['cat','other.md'])),
 ('wrong-code',lambda r:r[3]['payload']['item'].update(exit_code=1,status='failed')),
 ('bool-code',lambda r:r[3]['payload']['item'].update(exit_code=False)),
 ('bad-status',lambda r:r[3]['payload']['item'].update(status='running')),
 ('missing-id',lambda r:r[3]['payload']['item'].pop('id')),
 ('empty-id',lambda r:r[3]['payload']['item'].update(id='')),
 ('context-mismatch',lambda r:r[1]['payload'].update(turn_id='other')),
 ('old-completion',lambda r:r[-1]['payload'].update(turn_id='old')),
 ('aborted',lambda r:r.insert(3,rec('event_msg',type='turn_aborted',turn_id='current'))),
 ('unscoped-failure',lambda r:r.insert(2,rec('event_msg',type='error'))),
 ('assistant-spoof',lambda r:r[3].update(type='response_item')),
 ('child-root',lambda r:r[0]['payload'].update(source={'subagent':{'thread_spawn':{'parent_thread_id':'parent'}}})),
]:
 rs=copy.deepcopy(records);mutate(rs);results[name]=bind(rs)
rs=copy.deepcopy(records);rs.insert(4,copy.deepcopy(rs[3]));results['duplicate-runtime-id']=bind(rs)
rs=copy.deepcopy(records);other=copy.deepcopy(rs[3]);other['payload']['item']['id']='exec-two';rs.insert(4,other);results['duplicate-runtime-signature']=bind(rs)
rs=copy.deepcopy(records);other=copy.deepcopy(rs[3]);other['payload']['item'].update(id='exec-two',cwd=None);rs.insert(4,other);results['duplicate-invalid-runtime-cwd']=bind(rs)
rs=copy.deepcopy(records);other=copy.deepcopy(rs[3]);other['payload']['item'].update(id='exec-two',status='running');rs.insert(4,other);results['duplicate-invalid-runtime-status']=bind(rs)
es=copy.deepcopy(events);es.insert(3,copy.deepcopy(es[2]));results['duplicate-cli-id']=bind(es=es)
es=copy.deepcopy(events);other=copy.deepcopy(es[2]);other['item']['id']='item_1';es.insert(3,other);results['duplicate-cli-signature']=bind(es=es)
es=copy.deepcopy(events);other=copy.deepcopy(es[2]);other['item'].update(id='item_1',status='running');es.insert(3,other);results['duplicate-invalid-cli-status']=bind(es=es)
es=copy.deepcopy(events);es[2]['item']['command']=None;results['null-cli-command']=bind(es=es)
es=copy.deepcopy(events);es[2]['item']['command']=['cat','path'];results['array-cli-command']=bind(es=es)
rs=copy.deepcopy(records);rs[3]['payload']['item'].update(exit_code=1,status='failed');es=copy.deepcopy(events);es[2]['item'].update(exit_code=1,status='failed');results['failed-command']=bind(rs,es)
rs=copy.deepcopy(records);rs[1],rs[2]=rs[2],rs[1];results['start-first']=bind(rs)
rs=copy.deepcopy(records);old=copy.deepcopy(rs[3]);old['payload'].update(turn_id='old');old['payload']['item']['cwd']='file:///decoy/old';rs.insert(1,old);results['old-decoy']=bind(rs)
rs=copy.deepcopy(records);child=copy.deepcopy(rs[3]);child['payload'].update(thread_id='child');child['payload']['item']['cwd']='file:///decoy/child';rs.insert(4,child);results['child-decoy']=bind(rs)
rs=copy.deepcopy(records);rs.insert(1,rec('response_item',type='message',role='assistant',content=json.dumps(rs[3])));results['message-decoy']=bind(rs)
es=copy.deepcopy(events);es[0]['thread_id']='other';results['wrong-cli-root']=bind(es=es)
es=copy.deepcopy(events);es.append({'type':'turn.started'});results['incomplete-cli-turn']=bind(es=es)
results['malformed-trace']=bind_command_cwds('{broken',records)
results['malformed-records']=bind_command_cwds('\n'.join(map(json.dumps,events)),records+[3])
results['malformed-payload']=bind_command_cwds('\n'.join(map(json.dumps,events)),records+[{'type':'event_msg','payload':None}])
print(json.dumps(results))
`;

test("runtime source binds command cwd only with unique completed current-turn evidence", async () => {
  const run = await boundedProcess(
    ["uv", "run", "--no-project", "python", "-c", program, scripts],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  expect(run.code, run.err).toBe(0);
  const results = JSON.parse(run.out);
  const passes = new Set([
    "valid",
    "localhost",
    "failed-command",
    "start-first",
    "old-decoy",
    "child-decoy",
    "message-decoy",
  ]);
  for (const [name, result] of Object.entries(results)) {
    if (passes.has(name))
      expect(result, name).toEqual({ 2: "/actual/override" });
    else if (name === "percent")
      expect(result).toEqual({ 2: "/actual/space and 文" });
    else if (name === "root") expect(result).toEqual({ 2: "/" });
    else expect(result, name).toEqual({});
  }
});

const childProgram = String.raw`
import copy,json,sys
sys.path.insert(0,sys.argv[1])
from source_evidence import source_command_trace,bind_command_cwds
def rec(kind,**payload): return {'type':kind,'payload':payload}
command={'type':'CommandExecution','id':'exec-child','command':['/bin/zsh','-lc','cat policy.md'],'cwd':'file:///actual/child','exit_code':0,'status':'completed','aggregated_output':'current policy\n'}
metadata=rec('session_meta',id='child',cwd='/actual/child',source={'subagent':{'thread_spawn':{'parent_thread_id':'parent'}}})
history=[rec('turn_context',turn_id='parent-turn'),rec('event_msg',type='task_started',turn_id='parent-turn'),rec('event_msg',type='item_completed',thread_id='parent',turn_id='parent-turn',item={**command,'aggregated_output':'historical parent policy\n'}),rec('event_msg',type='task_complete',turn_id='parent-turn')]
records=[metadata,*history,rec('turn_context',turn_id='child-turn'),rec('event_msg',type='task_started',turn_id='child-turn'),rec('event_msg',type='item_completed',thread_id='child',turn_id='child-turn',item=command),rec('event_msg',type='task_complete',turn_id='child-turn')]
def summarize(rs):
 result=source_command_trace(rs)
 events=[json.loads(x) for x in result['trace_text'].splitlines()]
 items=[x['item'] for x in events if x['type']=='item.completed']
 return {**result,'items':items}
results={'valid-child':summarize(records)}
for name,mutate in [
 ('wrong-thread',lambda r:r[-2]['payload'].update(thread_id='parent')),
 ('wrong-turn',lambda r:r[-2]['payload'].update(turn_id='parent-turn')),
 ('missing-thread',lambda r:r[-2]['payload'].pop('thread_id')),
 ('missing-cwd',lambda r:r[-2]['payload']['item'].pop('cwd')),
 ('bad-status',lambda r:r[-2]['payload']['item'].update(status='running')),
 ('bad-command',lambda r:r[-2]['payload']['item'].update(command='cat policy.md')),
 ('missing-id',lambda r:r[-2]['payload']['item'].pop('id')),
 ('old-completion',lambda r:r[-1]['payload'].update(turn_id='parent-turn')),
 ('unfinished',lambda r:r.pop()),
 ('aborted',lambda r:r.insert(-1,rec('event_msg',type='turn_aborted',turn_id='child-turn'))),
 ('failed-command',lambda r:r[-2]['payload']['item'].update(exit_code=1,status='failed')),
 ('truncated-command',lambda r:r[-2]['payload']['item'].update(output_truncated=True)),
]:
 rs=copy.deepcopy(records);mutate(rs);results[name]=summarize(rs)
rs=copy.deepcopy(records);rs.insert(-1,copy.deepcopy(rs[-2]));results['duplicate-runtime']=summarize(rs)
rs=copy.deepcopy(records);rs.insert(-2,rec('response_item',type='custom_tool_call',name='exec',call_id='call-one',input='text(await tools.exec_command({cmd:"cat policy.md"}))'));results['tool-with-runtime']=summarize(rs)
rs=copy.deepcopy(records);rs[-2]=rec('response_item',type='function_call',name='opaque_reader',call_id='call-two',arguments='{}');results['missing-command-telemetry']=summarize(rs)
rs=copy.deepcopy(records);rs[-2]=rec('response_item',type='message',role='assistant',content=json.dumps(rs[-2]));results['message-spoof']=summarize(rs)
rs=copy.deepcopy(records);rs[-2]=rec('event_msg',type='item_started',thread_id='child',turn_id='child-turn',item=command);results['unfinished-command']=summarize(rs)
rs=copy.deepcopy(records);start=copy.deepcopy(rs[-2]);start['payload']['type']='item_started';start['payload']['item']['command']=['cat','other-policy.md'];rs.insert(-2,start);results['mismatched-command-start']=summarize(rs)
rs=copy.deepcopy(records);start=copy.deepcopy(rs[-2]);start['payload']['type']='item_started';rs.insert(-2,start);rs.insert(-2,copy.deepcopy(start));results['duplicate-command-start']=summarize(rs)
rs=copy.deepcopy(records);rs[-2]=rec('event_msg',type='item_completed',thread_id='child',turn_id='child-turn',item={'type':'McpToolCall','id':'opaque'});results['unknown-runtime-tool']=summarize(rs)
rs=copy.deepcopy(records);rs[-2]=rec('event_msg',type='mcp_tool_call_begin');results['tool-runtime-event']=summarize(rs)
rs=copy.deepcopy(records);rs[-2]=rec('response_item',type='web_search_call',name='web');results['built-in-tool-call']=summarize(rs)
for name,item in [('missing-item',None),('nondict-item','bad'),('missing-item-type',{}),('bad-item-type',{'type':3})]:
 rs=copy.deepcopy(records);rs[-2]['payload']['item']=item;results[name]=summarize(rs)
for output in ['function_call_output','custom_tool_call_output','tool_result','tool_output']:
 rs=copy.deepcopy(records);rs[-2]=rec('response_item',type=output,call_id='orphan',output='policy body');results['orphan-'+output]=summarize(rs)
results['malformed-records']=summarize(records+[3])
results['binder-still-rejects-child']=bind_command_cwds(results['valid-child']['trace_text'],records)
print(json.dumps(results))
`;

test("owned child source command evidence preserves unknown tools and current-turn scope", async () => {
  const run = await boundedProcess(
    ["uv", "run", "--no-project", "python", "-c", childProgram, scripts],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  expect(run.code, run.err).toBe(0);
  const all = JSON.parse(run.out);
  const valid = all["valid-child"];
  expect(valid.completed).toBe(true);
  expect(valid.unmodeledTools).toEqual([]);
  expect(valid.items).toHaveLength(1);
  expect(valid.items[0].aggregated_output).toBe("current policy\n");
  expect(valid.items[0].runtime_source_record).toBe(7);
  expect(valid.items[0].derived_from_runtime_source).toBe(true);
  expect(valid.command_cwds).toEqual({ 2: "/actual/child" });
  expect(valid.trace_text).not.toContain("historical parent policy");
  for (const name of [
    "old-completion",
    "unfinished",
    "aborted",
    "malformed-records",
  ]) {
    expect(all[name].completed, name).toBe(false);
    expect(all[name].trace_text, name).toBe("");
    expect(all[name].unmodeledTools.length, name).toBeGreaterThan(0);
  }
  for (const name of [
    "wrong-thread",
    "wrong-turn",
    "missing-thread",
    "bad-status",
    "bad-command",
    "missing-id",
    "missing-command-telemetry",
    "unfinished-command",
    "unknown-runtime-tool",
    "tool-runtime-event",
    "built-in-tool-call",
    "missing-item",
    "nondict-item",
    "missing-item-type",
    "bad-item-type",
    "orphan-function_call_output",
    "orphan-custom_tool_call_output",
    "orphan-tool_result",
    "orphan-tool_output",
  ]) {
    expect(all[name].items, name).toEqual([]);
    expect(all[name].unmodeledTools.length, name).toBeGreaterThan(0);
  }
  expect(all["missing-cwd"].items).toHaveLength(1);
  expect(all["missing-cwd"].command_cwds).toEqual({});
  expect(all["missing-cwd"].unmodeledTools).toHaveLength(1);
  expect(all["duplicate-runtime"].unmodeledTools).toHaveLength(1);
  expect(all["mismatched-command-start"].unmodeledTools).toHaveLength(1);
  expect(all["duplicate-command-start"].unmodeledTools).toHaveLength(1);
  expect(all["tool-with-runtime"].items).toHaveLength(1);
  expect(all["tool-with-runtime"].unmodeledTools[0].callId).toBe("call-one");
  expect(all["message-spoof"].items).toEqual([]);
  expect(all["message-spoof"].unmodeledTools).toEqual([]);
  expect(all["failed-command"].items[0].exit_code).toBe(1);
  expect(all["failed-command"].items[0].status).toBe("failed");
  expect(all["truncated-command"].items[0].output_truncated).toBe(true);
  expect(all["binder-still-rejects-child"]).toEqual({});
});

const engine = join(homedir(), ".local/share/codex-skills/repository");
const installedEngine = existsSync(join(engine, "scripts/activation_trace.py"))
  ? test
  : test.skip;
installedEngine(
  "later child summary cannot erase earlier owned reads or unknown source phases",
  async () => {
    const code = String.raw`
import copy,json,os,pathlib,subprocess,sys,tempfile
sys.path.insert(0,sys.argv[1]);sys.path.insert(0,str(pathlib.Path(sys.argv[2])/'scripts'))
from source_evidence import source_command_trace
from ordinary_trace import score_descendants
def rec(kind,**payload):return {'type':kind,'payload':payload}
with tempfile.TemporaryDirectory(prefix='multi-child-source-',dir=os.environ.get('TMPDIR')) as tmp:
 root=pathlib.Path(tmp);p=root/'SKILL.md';p.write_text('# TypeScript\nReal policy body.\n')
 results={}
 for label,argv in [('read',['cat',str(p)]),('partial-failure',['head','-n','5',str(p),str(root/'missing.md')]),('unknown-reader',[sys.executable,'-c','from pathlib import Path; print(Path('+repr(str(p))+').read_text()[:0],end="")'])]:
  run=subprocess.run(argv,cwd=root,capture_output=True,text=True)
  first=[rec('turn_context',turn_id='first'),rec('event_msg',type='task_started',turn_id='first'),rec('event_msg',type='item_completed',thread_id='child',turn_id='first',item={'type':'CommandExecution','id':'first-exec','command':argv,'cwd':root.as_uri(),'status':'completed' if run.returncode==0 else 'failed','exit_code':run.returncode,'aggregated_output':run.stdout+run.stderr}),rec('event_msg',type='task_complete',turn_id='first')]
  later=[rec('turn_context',turn_id='summary'),rec('event_msg',type='task_started',turn_id='summary'),rec('event_msg',type='task_complete',turn_id='summary')]
  meta=rec('session_meta',id='child',cwd=str(root),source={'subagent':{'thread_spawn':{'parent_thread_id':'parent'}}})
  records=[meta,*first,*later]
  request={'targets':{'typescript':{'path':str(p),'content':p.read_text()}},'required':[],'forbidden':['typescript']}
  parent=[rec('session_meta',id='parent',cwd=str(root),source='cli')]
  scored=score_descendants({'result':{'passed':True,'completed':True,'reads':[],'failures':[]}},request,parent,[records])
  results[label]={'view':source_command_trace(records),'passed':scored['result']['passed'],'actualCode':run.returncode}
  if label=='read':
   inherited=copy.deepcopy(records);inherited[3]['payload']['thread_id']='parent'
   results['inherited-parent']=source_command_trace(inherited)
   ambiguous=copy.deepcopy(records);ambiguous.pop(3)
   ambiguous.insert(3,rec('response_item',type='custom_tool_call',name='exec',input='unknown()'))
   results['ownerless']=source_command_trace(ambiguous)
   missing_context=copy.deepcopy(records);missing_context.pop(1)
   results['missing-first-context']=source_command_trace(missing_context)
   late=[meta,*later,copy.deepcopy(first[2])];late[-1]['payload']['turn_id']='summary'
   results['late-command']=source_command_trace(late)
   late_tool=[meta,*later,rec('response_item',type='custom_tool_call_output',call_id='late',output='opaque')]
   results['late-output']=source_command_trace(late_tool)
   refresh=[meta,*first[:-1],rec('turn_context',turn_id='first'),first[-1]]
   results['context-refresh']=source_command_trace(refresh)
   restart=[meta,*first[:-1],rec('event_msg',type='task_started',turn_id='first'),first[-1]]
   results['repeated-start']=source_command_trace(restart)
   mcp=rec('event_msg',type='item_completed',thread_id='child',turn_id='first',item={'type':'McpToolCall','id':'mcp-read','output':run.stdout})
   mcp_refresh=[meta,first[0],first[1],rec('response_item',type='custom_tool_call',name='node_repl',input='opaque'),mcp,rec('response_item',type='custom_tool_call_output',call_id='mcp-read',output=run.stdout),rec('turn_context',turn_id='first'),first[-1]]
   results['mcp-refresh']=source_command_trace(mcp_refresh)
   results['mcp-before-phase']=source_command_trace([meta,mcp,*first[:2],first[-1]])
   unowned=copy.deepcopy(mcp);unowned['payload'].pop('thread_id')
   results['unowned-before-phase']=source_command_trace([meta,unowned,*first[:2],first[-1]])
   results['orphan-before-phase']=source_command_trace([meta,rec('response_item',type='custom_tool_call_output',output=run.stdout),*first[:2],first[-1]])
 print(json.dumps(results))
`;
    const run = await boundedProcess(
      ["uv", "run", "--no-project", "python", "-c", code, scripts, engine],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
    );
    expect(run.code, run.err).toBe(0);
    const r = JSON.parse(run.out);
    for (const key of ["read", "partial-failure", "unknown-reader"]) {
      expect(r[key].view.completed, key).toBe(false);
      expect(r[key].view.unmodeledTools.length).toBeGreaterThan(0);
      expect(r[key].passed).toBe(false);
    }
    expect(r["partial-failure"].actualCode).not.toBe(0);
    expect(r["inherited-parent"].completed).toBe(true);
    expect(r["inherited-parent"].unmodeledTools).toEqual([]);
    expect(r.ownerless.completed).toBe(false);
    expect(r["missing-first-context"].completed).toBe(false);
    expect(r["late-command"].completed).toBe(false);
    expect(r["late-output"].completed).toBe(false);
    for (const key of [
      "context-refresh",
      "repeated-start",
      "mcp-refresh",
      "mcp-before-phase",
      "unowned-before-phase",
      "orphan-before-phase",
    ])
      expect(r[key].completed, key).toBe(false);
  },
);

installedEngine(
  "actual child subprocess read remains visible to the canonical forbidden-read scorer",
  async () => {
    const code = String.raw`
import json,os,pathlib,subprocess,sys,tempfile
sys.path.insert(0,sys.argv[1]);sys.path.insert(0,str(pathlib.Path(sys.argv[2])/'scripts'))
from source_evidence import source_command_trace
from activation_trace import score_trace
def rec(kind,**payload): return {'type':kind,'payload':payload}
with tempfile.TemporaryDirectory(prefix='child-source-read-',dir=os.environ.get('TMPDIR')) as tmp:
 root=pathlib.Path(tmp);path=root/'SKILL.md';path.write_text('# TypeScript\nReal policy body.\n')
 argv=['cat',str(path)];result=subprocess.run(argv,cwd=root,capture_output=True,text=True,check=True)
 records=[rec('session_meta',id='child',source={'subagent':{'thread_spawn':{'parent_thread_id':'parent'}}}),rec('turn_context',turn_id='current'),rec('event_msg',type='task_started',turn_id='current'),rec('event_msg',type='item_completed',thread_id='child',turn_id='current',item={'type':'CommandExecution','id':'actual','command':argv,'cwd':root.as_uri(),'exit_code':result.returncode,'status':'completed','aggregated_output':result.stdout}),rec('event_msg',type='task_complete',turn_id='current')]
 derived=source_command_trace(records)
 scored=score_trace(derived['trace_text'],{'typescript':{'path':str(path),'content':path.read_text()}},[],['typescript'])
 print(json.dumps({'derived':derived,'score':scored}))
`;
    const run = await boundedProcess(
      ["uv", "run", "--no-project", "python", "-c", code, scripts, engine],
      {
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    expect(run.code, run.err).toBe(0);
    const result = JSON.parse(run.out);
    expect(result.derived.completed).toBe(true);
    expect(result.derived.unmodeledTools).toEqual([]);
    expect(result.score.passed).toBe(false);
    expect(result.score.failures).toContain(
      "Forbidden guidance was read: typescript",
    );
  },
);

installedEngine(
  "all tool representations preserve uncertainty across phase boundaries and invalid owners",
  async () => {
    const code = String.raw`
import copy,json,os,pathlib,subprocess,sys,tempfile
sys.path.insert(0,sys.argv[1]);sys.path.insert(0,str(pathlib.Path(sys.argv[2])/'scripts'))
from source_evidence import source_command_trace
from ordinary_trace import score_descendants
def rec(kind,**payload):return {'type':kind,'payload':payload}
with tempfile.TemporaryDirectory(prefix='tool-phase-forms-',dir=os.environ.get('TMPDIR')) as tmp:
 root=pathlib.Path(tmp);p=root/'SKILL.md';p.write_text('# TypeScript\nActual policy body.\n')
 body=subprocess.run(['/bin/cat',str(p)],capture_output=True,text=True,check=True).stdout
 meta=rec('session_meta',id='child',cwd=str(root),source={'subagent':{'thread_spawn':{'parent_thread_id':'parent'}}})
 context=rec('turn_context',turn_id='current');start=rec('event_msg',type='task_started',turn_id='current');done=rec('event_msg',type='task_complete',turn_id='current')
 request={'targets':{'typescript':{'path':str(p),'content':body}},'required':[],'forbidden':['typescript']}
 parent=[rec('session_meta',id='parent',cwd=str(root),source='cli')]
 forms={}
 for kind in ['mcp_tool_call_begin','mcp_tool_call_end','collab_agent_spawn_begin','collab_waiting_end','future_unknown_runtime']:
  forms['runtime:'+kind]=rec('event_msg',type=kind,thread_id='child',turn_id='current',output=body)
 for kind in ['tool_output','tool_result','function_call','custom_tool_call_output','future_unknown_response']:
  forms['response:'+kind]=rec('response_item',type=kind,name='node_repl',call_id='tool',output=body)
 forms['message:tool-role']=rec('response_item',type='message',role='tool',content=body)
 forms['message:nested-tool-result']=rec('response_item',type='message',role='assistant',content=[{'type':'tool_result','content':body}])
 for kind in ['function_call_output','custom_tool_call_output','tool_output','tool_result','future_unknown_record']:
  forms['outer:'+kind]=rec(kind,output=body)
 results={}
 for name,event in forms.items():
  for where,records in [('before',[meta,event,context,start,done]),('inside',[meta,context,start,event,done]),('after',[meta,context,start,done,event])]:
   scored=score_descendants({'result':{'passed':True,'completed':True,'reads':[],'failures':[]}},request,parent,[records])
   results[name+':'+where]=scored['result']['passed']
 owner_results={}
 for owner in ['', '   ', 'foreign-undeclared', ' parent ', '\tparent', 'parent']:
  history=[rec('turn_context',turn_id='earlier'),rec('event_msg',type='task_started',turn_id='earlier'),rec('event_msg',type='item_completed',thread_id=owner,turn_id='earlier',item={'type':'UserMessage'}),rec('response_item',type='custom_tool_call',name='node_repl',input='opaque'),rec('response_item',type='custom_tool_call_output',output=body),rec('event_msg',type='task_complete',turn_id='earlier')]
  owner_results[owner]=source_command_trace([meta,*history,context,start,done])
 print(json.dumps({'cases':results,'owners':owner_results}))
`;
    const run = await boundedProcess(
      ["uv", "run", "--no-project", "python", "-c", code, scripts, engine],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
    );
    expect(run.code, run.err).toBe(0);
    const r = JSON.parse(run.out);
    expect(Object.keys(r.cases)).toHaveLength(51);
    for (const [name, passed] of Object.entries(r.cases))
      expect(passed, name).toBe(false);
    for (const owner of [
      "",
      "   ",
      "foreign-undeclared",
      " parent ",
      "\tparent",
    ])
      expect(r.owners[owner].completed).toBe(false);
    expect(r.owners.parent.completed).toBe(true);
    expect(r.owners.parent.unmodeledTools).toEqual([]);
  },
);

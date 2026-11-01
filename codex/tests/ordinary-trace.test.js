import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, writeFile, chmod, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedProcess } from "./lib/process.js";

const script = fileURLToPath(
  new URL("../scripts/ordinary_trace.py", import.meta.url),
);
const engine =
  process.env.CODEX_SKILL_ENGINE_ROOT ||
  join(homedir(), ".local/share/codex-skills/repository");
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const done = { type: "turn.completed" };
const event = (command, output, exit = 0, id = "read-1") => ({
  type: "item.completed",
  item: {
    type: "command_execution",
    id,
    command,
    aggregated_output: output,
    exit_code: exit,
  },
});
const trace = (...events) => [...events, done].map(JSON.stringify).join("\n");
const started = (event) => ({
  type: "item.started",
  item: {
    id: event.item.id,
    type: event.item.type,
    command: event.item.command,
  },
});

async function adapter(request, integrate = false) {
  const child = Bun.spawn(
    [
      "uv",
      "run",
      "--offline",
      "--no-project",
      "--no-cache",
      "python",
      "-B",
      script,
      ...(integrate ? ["--engine-root", engine] : ["--adapt-only"]),
    ],
    {
      stdin: new Blob([JSON.stringify(request)]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    },
  );
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, err).toBe(0);
  return JSON.parse(out);
}

async function fixture(run) {
  const root = await realpath(
    await mkdtemp(join(process.env.TMPDIR || tmpdir(), "ordinary-reads-")),
  );
  try {
    const paths = {
      frontend: join(root, "front end 'quoted' $;#.md"),
      typescript: join(root, "typescript.md"),
      note: join(root, "note.txt"),
    };
    const content = {
      frontend: "# Frontend\nRead the complete design policy first.\n",
      typescript: "# TypeScript\nRead the complete type policy.\n",
      note: "Synthetic fixture source.\n",
    };
    for (const key of Object.keys(paths))
      await writeFile(paths[key], content[key]);
    const targets = {
      "frontend-ui": { path: paths.frontend, content: content.frontend },
      typescript: { path: paths.typescript, content: content.typescript },
    };
    const files = { [paths.note]: content.note };
    const actual = async (command) => {
      const result = await boundedProcess(["/bin/sh", "-c", command], {
        cwd: root,
        timeout: 5000,
      });
      return event(command, result.out + result.err, result.code);
    };
    await run({ root, paths, content, targets, files, actual });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("ordinary adapter reconstructs genuine sequential reads and preserves component provenance", async () => {
  await fixture(async ({ paths, targets, actual }) => {
    const source = await actual(
      `cat ${quote(paths.frontend)} && cat ${quote(paths.typescript)}`,
    );
    const result = await adapter({ trace_text: trace(source), targets });
    expect(
      result.attributions.map((a) => [
        a.sourceEvent,
        a.component,
        a.operand,
        a.path,
      ]),
    ).toEqual([
      [0, 0, 0, paths.frontend],
      [0, 1, 0, paths.typescript],
    ]);
    for (const a of result.attributions) {
      expect(a.outerExitCode).toBe(0);
      expect(a.outerOutputSha256).toHaveLength(64);
      expect(a.statusEvidence).toContain("deduction");
    }
    expect(result.trace).toContain("ordinary_source_component");
  });
});

test("multi-file cat, fixture reads and inert separators retain real source order", async () => {
  await fixture(async ({ paths, content, targets, files, actual }) => {
    for (const command of [
      `cat ${quote(paths.frontend)} ${quote(paths.typescript)}`,
      `\ncat ${quote(paths.frontend)} &&\n cat ${quote(paths.typescript)}\n`,
      `cat ${quote(paths.note)} && printf '\\n---\\n' && cat ${quote(paths.frontend)} && printf '%s\\n' separator && cat ${quote(paths.typescript)}`,
    ]) {
      const source = await actual(command);
      const result = await adapter({
        trace_text: trace(source),
        targets,
        files,
      });
      expect(
        result.attributions
          .filter((a) => a.path !== paths.note)
          .map((a) => a.path),
      ).toEqual([paths.frontend, paths.typescript]);
      expect(result.trace).toContain(
        content.typescript.trim().replaceAll("\n", "\\n"),
      );
    }
  });
});

test("standard shell wrappers, quote concatenation and repeated reads are literal", async () => {
  await fixture(async ({ paths, targets, actual }) => {
    const command = `cat ${quote(paths.frontend)} && cat ${quote(paths.typescript)} && cat ${quote(paths.frontend)}`;
    const source = await actual(command);
    source.item.command = `/bin/sh -lc ${quote(command)}`;
    const result = await adapter({ trace_text: trace(source), targets });
    expect(result.attributions.map((a) => a.path)).toEqual([
      paths.frontend,
      paths.typescript,
      paths.frontend,
    ]);
    expect(new Set(result.attributions.map((a) => a.component)).size).toBe(3);
  });
});

test("sed continuation chunks reconstruct only the actual bounded output", async () => {
  await fixture(async ({ paths, content, targets, actual }) => {
    const source = await actual(
      `sed -n '1p' ${quote(paths.frontend)} && sed -n '2,100p' ${quote(paths.frontend)} && cat ${quote(paths.typescript)}`,
    );
    const result = await adapter({ trace_text: trace(source), targets });
    expect(result.attributions.map((a) => a.command)).toEqual([
      `sed -n 1,1p ${quote(paths.frontend)}`,
      `sed -n 2,100p ${quote(paths.frontend)}`,
      `cat ${paths.typescript}`,
    ]);
    expect(source.item.aggregated_output).toBe(
      content.frontend + content.typescript,
    );
  });
});

test("relative paths need separately established execution cwd", async () => {
  await fixture(async ({ root, paths, targets, files, actual }) => {
    const source = await actual(
      `cat note.txt && cat ${quote(paths.typescript)}`,
    );
    const request = { trace_text: trace(source), targets, files };
    expect((await adapter(request)).attributions).toEqual([]);
    const proven = await adapter({ ...request, cwd: root });
    expect(proven.attributions.map((a) => a.path)).toEqual([
      paths.note,
      paths.typescript,
    ]);
    const pwd = await actual(`pwd && cat ${quote(paths.typescript)}`);
    expect(
      (await adapter({ trace_text: trace(pwd), targets, cwd: root }))
        .attributions,
    ).toHaveLength(1);
    expect(
      (await adapter({ trace_text: trace(pwd), targets })).attributions,
    ).toEqual([]);
  });
});

test("printed policy text never becomes proof of a file read", async () => {
  await fixture(async ({ paths, content, targets, files, actual }) => {
    for (const command of [
      `printf '%s' ${quote(content.typescript)}`,
      `echo ${quote(paths.typescript)}`,
      `true # cat ${quote(paths.typescript)}`,
    ]) {
      const source = await actual(command);
      const result = await adapter({
        trace_text: trace(source),
        targets,
        files,
      });
      expect(result.attributions).toEqual([]);
      expect(result.trace).toBe(trace(source));
    }
    const source = await actual(
      `printf '%s' ${quote(content.typescript)} && cat ${quote(paths.note)}`,
    );
    const result = await adapter({ trace_text: trace(source), targets, files });
    expect(result.attributions.map((a) => a.path)).toEqual([paths.note]);
  });
});

test("short circuits, semicolons and failure masking retain the original evidence", async () => {
  await fixture(async ({ paths, targets, actual }) => {
    for (const command of [
      `false && cat ${quote(paths.typescript)}`,
      `false; cat ${quote(paths.typescript)}`,
      `cat ${quote(paths.frontend)}\ncat ${quote(paths.typescript)}`,
      `false || cat ${quote(paths.typescript)}`,
      `cat ${quote(paths.typescript)}; true`,
      `cat ${quote(paths.typescript)} && false || printf 'ok\\n'`,
    ]) {
      const source = await actual(command);
      const result = await adapter({ trace_text: trace(source), targets });
      expect(result.attributions).toEqual([]);
      expect(result.trace).toBe(trace(source));
    }
  });
});

test("overall failed partial readers cannot gain positive proof", async () => {
  await fixture(async ({ root, paths, targets, actual }) => {
    for (const command of [
      `cat ${quote(paths.typescript)} ${quote(join(root, "missing.md"))}`,
      `head -n 5 ${quote(paths.typescript)} ${quote(join(root, "missing.md"))}`,
      `cat -n ${quote(paths.typescript)} ${quote(join(root, "missing.md"))}`,
    ]) {
      const source = await actual(command);
      expect(source.item.exit_code).not.toBe(0);
      const result = await adapter({ trace_text: trace(source), targets });
      expect(result.attributions).toEqual([]);
      expect(result.trace).toBe(trace(source));
    }
  });
});

test("reordered, decorated, truncated and incomplete output cannot be reconstructed", async () => {
  await fixture(async ({ paths, content, targets, actual }) => {
    const source = await actual(
      `cat ${quote(paths.frontend)} && cat ${quote(paths.typescript)}`,
    );
    for (const text of [
      content.typescript + content.frontend,
      source.item.aggregated_output.slice(0, -1),
      "warning: truncated output\n" + source.item.aggregated_output,
      source.item.aggregated_output
        .split("\n")
        .map((line, i) => `${i + 1} ${line}`)
        .join("\n"),
    ]) {
      const changed = {
        ...source,
        item: { ...source.item, aggregated_output: text },
      };
      const result = await adapter({ trace_text: trace(changed), targets });
      expect(result.attributions).toEqual([]);
      expect(result.trace).toBe(trace(changed));
    }
  });
});

test("computed paths, pipes, redirections and custom executables remain unsupported", async () => {
  await fixture(async ({ root, paths, targets, actual }) => {
    const custom = join(root, "cat");
    await writeFile(custom, '#!/bin/sh\nexec /bin/cat "$@"\n');
    await chmod(custom, 0o755);
    for (const command of [
      `cat "$(printf '%s' ${quote(paths.typescript)})"`,
      `cat ${quote(paths.typescript)} | cat`,
      `cat < ${quote(paths.typescript)}`,
      `${quote(custom)} ${quote(paths.typescript)}`,
      `cat ${quote(paths.typescript)} && (cat ${quote(paths.frontend)})`,
    ]) {
      const source = await actual(command);
      const result = await adapter({ trace_text: trace(source), targets });
      expect(result.attributions).toEqual([]);
      expect(result.trace).toBe(trace(source));
    }
  });
});

test("unknown printf contracts and unlisted operands do not erase uncertainty", async () => {
  await fixture(async ({ paths, targets, actual }) => {
    for (const command of [
      `printf '%b' 'separator\\n' && cat ${quote(paths.typescript)}`,
      `cat ${quote(paths.note)} && cat ${quote(paths.typescript)}`,
      `printf '%s' x extra && cat ${quote(paths.typescript)}`,
      `cat --number ${quote(paths.typescript)}`,
    ]) {
      const source = await actual(command);
      const result = await adapter({ trace_text: trace(source), targets });
      expect(result.attributions).toEqual([]);
      expect(result.trace).toBe(trace(source));
    }
  });
});

test("duplicate identities, malformed records and unfinished events preserve scorer integrity", async () => {
  await fixture(async ({ paths, targets, actual }) => {
    const source = await actual(`cat ${quote(paths.typescript)}`);
    for (const input of [
      trace(source, source),
      trace(source, {
        ...source,
        item: { ...source.item, command: "echo spoof" },
      }),
      trace({ ...source, type: "item.started" }),
      trace({ ...source, item: { ...source.item, id: "" } }),
      trace({ ...source, item: { ...source.item, truncated: true } }),
    ]) {
      const result = await adapter({ trace_text: input, targets });
      expect(result.attributions).toEqual([]);
      expect(result.trace).toBe(input);
    }
    const malformed = trace(source) + "\n{bad";
    expect((await adapter({ trace_text: malformed, targets })).trace).toContain(
      "{bad",
    );
    const collision = trace(
      source,
      event("printf ok", "ok", 0, "ordinary:0:0"),
    );
    expect(
      (await adapter({ trace_text: collision, targets })).attributions,
    ).toEqual([]);
  });
});

test("input-file mode uses the same request schema without importing the scorer", async () => {
  await fixture(async ({ root, paths, targets, actual }) => {
    const source = await actual(`cat ${quote(paths.typescript)}`);
    const input = join(root, "request.json");
    await writeFile(
      input,
      JSON.stringify({ trace_text: trace(source), targets }),
    );
    const result = await boundedProcess([
      "uv",
      "run",
      "--offline",
      "--no-project",
      "--no-cache",
      "python",
      "-B",
      script,
      "--adapt-only",
      "--input-file",
      input,
    ]);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out).attributions).toHaveLength(1);
  });
});

const maintainedScorer = existsSync(join(engine, "scripts/activation_trace.py"))
  ? test
  : test.skip;
maintainedScorer(
  "maintained scorer accepts derived order and still rejects reversed, failed, unknown and printed evidence",
  async () => {
    await fixture(async ({ root, paths, content, targets, files, actual }) => {
      const request = async (source, assertions = {}) =>
        adapter(
          {
            trace_text: trace(source),
            targets,
            files,
            required: ["frontend-ui", "typescript"],
            before: [["frontend-ui", "typescript"]],
            ...assertions,
          },
          true,
        );
      const good = await request(
        await actual(
          `cat ${quote(paths.frontend)} && cat ${quote(paths.typescript)}`,
        ),
      );
      expect(good.strictResult.passed).toBe(false);
      expect(good.result.passed).toBe(true);
      expect(good.attributions).toHaveLength(2);
      expect(
        (
          await request(
            await actual(
              `cat ${quote(paths.typescript)} && cat ${quote(paths.frontend)}`,
            ),
          )
        ).result.passed,
      ).toBe(false);
      expect(
        (
          await request(
            await actual(
              `cat ${quote(paths.frontend)} ${quote(paths.typescript)}`,
            ),
          )
        ).result.passed,
      ).toBe(true);
      const simpleFront = join(root, "frontend-simple.md");
      await writeFile(simpleFront, content.frontend);
      targets["frontend-ui"].aliases = [simpleFront];
      const chunks = await request(
        await actual(
          `sed -n '1p' ${quote(simpleFront)} && sed -n '2,100p' ${quote(simpleFront)} && cat ${quote(paths.typescript)}`,
        ),
      );
      expect(chunks.result.passed).toBe(true);
      const opaqueEarly = await actual(
        `cat "$(printf '%s' ${quote(paths.typescript)})"`,
      );
      opaqueEarly.item.id = "opaque-early";
      const ordinaryLater = await actual(
        `cat ${quote(paths.frontend)} && cat ${quote(paths.typescript)}`,
      );
      const preserved = await adapter(
        {
          trace_text: trace(opaqueEarly, ordinaryLater),
          targets,
          required: ["frontend-ui", "typescript"],
          before: [["frontend-ui", "typescript"]],
        },
        true,
      );
      expect(preserved.result.passed).toBe(false);
      expect(preserved.attributions.map((a) => a.sourceEvent)).toEqual([1, 1]);
      for (const command of [
        `cat ${quote(paths.typescript)} ${quote(join(root, "missing.md"))}`,
        `head -n 5 ${quote(paths.typescript)} ${quote(join(root, "missing.md"))}`,
        `cat -n ${quote(paths.typescript)} ${quote(join(root, "missing.md"))}`,
        `cat "$(printf '%s' ${quote(paths.typescript)})"`,
        `printf '%s' ${quote(content.typescript)} && cat ${quote(paths.note)}`,
      ]) {
        const result = await request(await actual(command), {
          required: [],
          before: [],
          forbidden: ["typescript"],
        });
        expect(result.result.passed, command).toBe(false);
        expect(
          result.result.reads.filter((r) => r.target === "typescript"),
        ).toEqual([]);
      }
      const disjoint = await request(await actual(`cat ${quote(paths.note)}`), {
        required: [],
        before: [],
        forbidden: ["typescript"],
      });
      expect(disjoint.result.passed).toBe(true);
      const unfinished = await adapter(
        {
          trace_text: JSON.stringify(
            await actual(`cat ${quote(paths.typescript)}`),
          ),
          targets,
          required: ["typescript"],
        },
        true,
      );
      expect(unfinished.result.passed).toBe(false);
    });
  },
);

maintainedScorer(
  "actual early and unfinished command/MCP reads cannot hide behind later completion",
  async () => {
    await fixture(async ({ paths, targets, actual }) => {
      const ts = await actual(`cat ${quote(paths.typescript)}`);
      ts.item.id = "ts";
      const front = await actual(`cat ${quote(paths.frontend)}`);
      front.item.id = "front";
      const note = await actual(`cat ${quote(paths.note)}`);
      note.item.id = "note";
      const score = (events, assertions = {}) =>
        adapter(
          {
            trace_text: trace(...events),
            targets,
            required: ["frontend-ui", "typescript"],
            before: [["frontend-ui", "typescript"]],
            ...assertions,
          },
          true,
        );
      expect(
        (await score([started(ts), started(front), front, ts])).result.passed,
      ).toBe(false);
      expect(
        (await score([started(front), front, started(ts), ts])).result.passed,
      ).toBe(true);
      expect(
        (
          await score([
            started(note),
            started(front),
            front,
            started(ts),
            ts,
            note,
          ])
        ).result.passed,
      ).toBe(true);
      expect((await score([front, ts])).result.passed).toBe(false);
      const earlyMcp = {
        type: "item.started",
        item: {
          id: "early-mcp",
          type: "mcp_tool_call",
          server: "functions",
          tool: "exec_command",
          status: "in_progress",
          arguments: { cmd: `cat ${quote(paths.typescript)}` },
        },
      };
      for (const early of [
        started({ ...ts, item: { ...ts.item, id: "early" } }),
        earlyMcp,
      ]) {
        expect(
          (await score([early, started(front), front, started(ts), ts])).result
            .passed,
        ).toBe(false);
        expect(
          (
            await score([early], {
              required: [],
              before: [],
              forbidden: ["typescript"],
            })
          ).result.passed,
        ).toBe(false);
      }
      const disjointMcp = {
        ...earlyMcp,
        item: {
          ...earlyMcp.item,
          arguments: { cmd: `cat ${quote(paths.note)}` },
        },
      };
      expect(
        (
          await score([disjointMcp], {
            required: [],
            before: [],
            forbidden: ["typescript"],
          })
        ).result.passed,
      ).toBe(true);
      const combined = await actual(
        `cat ${quote(paths.frontend)} && cat ${quote(paths.typescript)}`,
      );
      expect((await score([started(combined), combined])).result.passed).toBe(
        true,
      );
    });
  },
);

maintainedScorer(
  "start and terminal records must describe the same chronological command or MCP call",
  async () => {
    await fixture(async ({ paths, targets, content, actual }) => {
      const ts = await actual(`cat ${quote(paths.typescript)}`);
      ts.item.id = "paired";
      const note = await actual(`cat ${quote(paths.note)}`);
      note.item.id = "paired";
      const score = (events, required = []) =>
        adapter(
          {
            trace_text: trace(...events),
            targets,
            required,
            forbidden: required.length ? [] : ["typescript"],
          },
          true,
        );
      expect((await score([started(ts), note])).result.passed).toBe(false);
      expect(
        (await score([started(note), ts], ["typescript"])).result.passed,
      ).toBe(false);
      expect(
        (await score([ts, started(ts)], ["typescript"])).result.passed,
      ).toBe(false);
      expect(
        (await score([started(ts), ts], ["typescript"])).result.passed,
      ).toBe(true);
      const mcp = (cmd, output, type = "item.completed") => ({
        type,
        item: {
          id: "mcp",
          type: "mcp_tool_call",
          server: "functions",
          tool: "exec_command",
          status: type === "item.started" ? "in_progress" : "completed",
          arguments: { cmd },
          result: {
            content: [
              { type: "text", text: JSON.stringify({ exit_code: 0, output }) },
            ],
          },
        },
      });
      const early = mcp(ts.item.command, "", "item.started");
      expect(
        (
          await score([
            early,
            mcp(note.item.command, note.item.aggregated_output),
          ])
        ).result.passed,
      ).toBe(false);
      const valid = mcp(note.item.command, note.item.aggregated_output);
      expect(
        (await score([mcp(note.item.command, "", "item.started"), valid]))
          .result.passed,
      ).toBe(true);
      for (const change of [
        { server: "other" },
        { tool: "other" },
        { arguments: { cmd: ts.item.command } },
      ])
        expect(
          (
            await score([
              { ...early, item: { ...early.item, ...change } },
              valid,
            ])
          ).result.passed,
        ).toBe(false);
    });
  },
);

maintainedScorer(
  "whole-run guidance evidence includes forbidden, opaque and incomplete descendants",
  async () => {
    await fixture(async ({ root, paths, content, targets, actual }) => {
      const records = (id, parent, command) => [
        {
          type: "session_meta",
          payload: {
            id,
            cwd: root,
            source: parent
              ? { subagent: { thread_spawn: { parent_thread_id: parent } } }
              : "cli",
          },
        },
        { type: "turn_context", payload: { turn_id: id + "-turn" } },
        {
          type: "event_msg",
          payload: { type: "task_started", turn_id: id + "-turn" },
        },
        ...(command
          ? [
              {
                type: "event_msg",
                payload: {
                  type: "item_completed",
                  thread_id: id,
                  turn_id: id + "-turn",
                  item: {
                    type: "CommandExecution",
                    id: id + "-exec",
                    command: ["/bin/sh", "-c", command.item.command],
                    cwd: "file://" + root,
                    status:
                      command.item.exit_code === 0 ? "completed" : "failed",
                    exit_code: command.item.exit_code,
                    aggregated_output: command.item.aggregated_output,
                  },
                },
              },
            ]
          : []),
        {
          type: "event_msg",
          payload: { type: "task_complete", turn_id: id + "-turn" },
        },
      ];
      const parent = records("root");
      const rootTrace = trace(
        { type: "thread.started", thread_id: "root" },
        { type: "turn.started" },
      );
      const score = (children = [], source = parent) =>
        adapter(
          {
            trace_text: rootTrace,
            targets,
            required: [],
            forbidden: ["typescript"],
            source_records: source,
            descendant_sources: children,
          },
          true,
        );
      expect((await score()).result.passed).toBe(true);
      const forbidden = records(
        "child",
        "root",
        await actual(`cat ${quote(paths.typescript)}`),
      );
      const rejected = await score([forbidden]);
      expect(rejected.result.passed).toBe(false);
      expect(rejected.result.failures).toContain(
        "Descendant: Forbidden guidance was read: typescript",
      );
      const unrelated = records(
        "child",
        "root",
        await actual(`cat ${quote(paths.note)}`),
      );
      expect((await score([unrelated])).result.passed).toBe(true);
      const opaque = structuredClone(unrelated);
      opaque.splice(3, 0, {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "opaque",
          input: "unknown()",
        },
      });
      expect((await score([opaque])).result.passed).toBe(false);
      expect((await score([unrelated.slice(0, -1)])).result.passed).toBe(false);
      const orphan = structuredClone(unrelated);
      orphan[0].payload.source.subagent.thread_spawn.parent_thread_id = "other";
      expect((await score([orphan])).result.passed).toBe(false);
      const injected = structuredClone(unrelated);
      injected.splice(3, 0, {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: content.typescript }],
        },
      });
      expect((await score([injected])).result.failures).toContain(
        "Forbidden guidance was present in source input: typescript",
      );
      const grandchild = records(
        "grandchild",
        "child",
        await actual(`cat ${quote(paths.typescript)}`),
      );
      expect((await score([grandchild, unrelated])).result.passed).toBe(false);
    });
  },
);

test("relative and home reads require explicit source cwd or trusted launch HOME", async () => {
  await fixture(async ({ root, targets, content, paths }) => {
    const run = await boundedProcess(["/bin/sh", "-c", "cat ~/typescript.md"], {
      cwd: root,
      env: { ...process.env, HOME: root },
    });
    const e = event("cat ~/typescript.md", run.out + run.err, run.code);
    expect(run.code).toBe(0);
    expect(
      (await adapter({ trace_text: trace(e), targets })).attributions,
    ).toEqual([]);
    expect(
      (await adapter({ trace_text: trace(e), targets, home: root }))
        .attributions,
    ).toHaveLength(1);
    const relative = event("cat typescript.md", content.typescript);
    expect(
      (
        await adapter({
          trace_text: trace(relative),
          targets,
          command_cwds: { 0: root },
        })
      ).attributions,
    ).toHaveLength(1);
    expect(
      (
        await adapter({
          trace_text: trace(relative),
          targets,
          command_cwds: { 0: root + "/decoy" },
        })
      ).attributions,
    ).toEqual([]);
    for (const command of [
      "cat '~/typescript.md'",
      "HOME=/decoy cat ~/typescript.md",
      "cat ~someone/typescript.md",
    ])
      expect(
        (
          await adapter({
            trace_text: trace(event(command, content.typescript)),
            targets,
            home: root,
          })
        ).attributions,
      ).toEqual([]);
  });
});

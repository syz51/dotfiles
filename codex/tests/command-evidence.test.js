import { test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  commandLists,
  commandWords,
  checkCommand,
  successfulCommand,
  successfulSourceCommand,
} from "./lib/command-evidence.js";
import { boundedProcess } from "./lib/process.js";

const contract = { tool: "uv", script: "check.py" };
const event = (command, output = "fixture-check:ok\n", exit_code = 0) => ({
  type: "item.completed",
  item: {
    type: "command_execution",
    command,
    aggregated_output: output,
    exit_code,
  },
});
const quote = (s) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const sourceRecords = (
  command,
  cwd,
  output = "fixture-check:ok\n",
  exit_code = 0,
) => [
  { type: "session_meta", payload: { id: "root", cwd } },
  { type: "turn_context", payload: { turn_id: "current" } },
  { type: "event_msg", payload: { type: "task_started", turn_id: "current" } },
  {
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: "root",
      turn_id: "current",
      item: {
        type: "CommandExecution",
        id: "exec-one",
        command,
        cwd: pathToFileURL(cwd).href,
        status: "completed",
        aggregated_output: output,
        exit_code,
      },
    },
  },
  { type: "event_msg", payload: { type: "task_complete", turn_id: "current" } },
];

test("literal grammar handles quote concatenation and one standard shell wrapper", () => {
  expect(commandWords("'u'v run 'py'\"thon\" 'check.py'")).toEqual([
    "uv",
    "run",
    "python",
    "check.py",
  ]);
  expect(commandLists("cat 'a && b' && uv run python check.py")).toEqual([
    ["cat", "a && b"],
    ["uv", "run", "python", "check.py"],
  ]);
  expect(
    commandLists(
      "/bin/zsh -lc " + quote("cat 'a b' && uv run python check.py"),
    ),
  ).toEqual([
    ["cat", "a b"],
    ["uv", "run", "python", "check.py"],
  ]);
  expect(commandWords("cat a && cat b")).toBeNull();
  for (const command of [
    "",
    "&& pwd",
    "pwd &&",
    "pwd && && pwd",
    "pwd & pwd",
    "pwd || pwd",
    "pwd; pwd",
    "pwd | cat",
    "pwd > /tmp/file",
    "pwd < /tmp/file",
    "pwd\npwd",
    "pwd\r",
    "pwd\0",
    "pwd # comment",
    "$(pwd)",
    "`pwd`",
    "cat *.py",
    "cat ~",
    "cat file?",
    "cat {a,b}",
    "cat a\\ b",
    'cat "$HOME"',
    'cat "`pwd`"',
    'cat "a\\nb"',
    "cat 'unclosed",
    "bash -c " + quote("sh -c 'pwd'"),
    "bash -x -c 'pwd'",
    "bash -c 'pwd' ignored",
  ])
    expect(commandLists(command), command).toBeNull();
});

test("safe all-and lists preserve exact check invocation and bounded inspection", () => {
  for (const command of [
    "pwd && uv run python check.py && cat calc.py",
    "ls -la && uv run --offline --no-project python -B ./check.py && sed -n '1,20p' calc.py",
    "rg --files && UV_OFFLINE=1 uv run --no-config python3 check.py",
    "rg -n total calc.py && uv run python check.py",
    "/bin/cat 'a b.py' && uv run python check.py && /usr/bin/sed -n '1,$p' calc.py",
    "uv run python check.py && uv run python check.py",
    "/bin/zsh -lc " + quote("cat 'a b.py' && uv run python check.py"),
  ])
    expect(successfulCommand([event(command)], contract), command).toBe(true);
  expect(
    successfulCommand([event("cat calc.js && bun run check.js")], {
      tool: "bun",
      script: "check.js",
    }),
  ).toBe(true);
  expect(
    successfulCommand([event("ls && npm run test && pwd")], {
      tool: "npm",
      script: "check.js",
    }),
  ).toBe(true);
});

test("unsupported side effects, check-shaped data and failure-masking programs stay unverified", () => {
  for (const command of [
    "echo 'uv run python check.py'",
    "printf 'uv run python check.py'",
    "cat 'uv run python check.py'",
    "true # uv run python check.py",
    "uv run python check.py; true",
    "false; uv run python check.py",
    "uv run python check.py || true",
    "false && uv run python check.py || printf fixture-check:ok",
    "uv run python check.py && echo ok",
    "uv run python check.py && printf fixture-check:ok",
    "uv run python check.py && touch marker",
    "uv run python check.py && python other.py",
    "uv run python check.py && sed -n '1e touch marker' calc.py",
    "uv run python check.py && sed -i -n '1p' calc.py",
    "uv run python check.py && cat -",
    "uv run python check.py && cat --help",
    "uv run python check.py && ls --sort=version",
    "uv run python check.py && rg --pre evil total calc.py",
    "uv run python check.py && rg -n --pre=evil calc.py",
    "uv run python check.py && /tmp/cat note",
    "./uv run python check.py",
    "/tmp/uv run python check.py",
    "command uv run python check.py",
    "PATH=/tmp uv run python check.py",
    "PYTHONPATH=/tmp uv run python check.py",
    "UV_PROJECT=/tmp uv run python check.py",
    "uv run python -c check.py",
    "uv run --unknown python check.py",
    "uv run python other.py",
  ])
    expect(checkCommand(command, contract), command).toBe(false);
  for (const change of [
    { type: "item.started" },
    { item: { ...event("").item, exit_code: 1 } },
    {
      item: {
        ...event("").item,
        aggregated_output: "fixture-check:ok suffix\n",
      },
    },
    { item: { ...event("").item, aggregated_output: "" } },
  ])
    expect(
      successfulCommand(
        [{ ...event("uv run python check.py"), ...change }],
        contract,
      ),
    ).toBe(false);
});

test("actual subprocess checks accept compound success and reject masked failure or printed evidence", async () => {
  const root = await mkdtemp(
    join(process.env.TMPDIR || tmpdir(), "command-evidence-"),
  );
  try {
    await writeFile(join(root, "check.py"), 'print("fixture-check:ok")\n');
    await writeFile(join(root, "fail.py"), "raise SystemExit(7)\n");
    await writeFile(join(root, "notes.txt"), "unchanged\n");
    const run = async (source) => {
      const result = await boundedProcess(["/bin/zsh", "-lc", source], {
        cwd: root,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
        timeout: 30000,
      });
      return event(
        "/bin/zsh -lc " + quote(source),
        result.out + result.err,
        result.code,
      );
    };
    const uv =
      "uv run --no-project --offline --no-cache --no-python-downloads python -B ";
    const actual = await run(
      "cat notes.txt && " + uv + "check.py && sed -n '1p' notes.txt",
    );
    expect(actual.item.exit_code).toBe(0);
    expect(successfulCommand([actual], contract)).toBe(true);
    const failed = await run(uv + "fail.py; printf '%s\\n' fixture-check:ok");
    expect(failed.item.exit_code).toBe(0);
    expect(failed.item.aggregated_output).toContain("fixture-check:ok");
    expect(successfulCommand([failed], { tool: "uv", script: "fail.py" })).toBe(
      false,
    );
    const fallback = await run(
      uv + "fail.py && cat notes.txt || printf '%s\\n' fixture-check:ok",
    );
    expect(fallback.item.exit_code).toBe(0);
    expect(
      successfulCommand([fallback], { tool: "uv", script: "fail.py" }),
    ).toBe(false);
    const skipped = await run(
      "false && " + uv + "check.py || printf '%s\\n' fixture-check:ok",
    );
    expect(skipped.item.exit_code).toBe(0);
    expect(successfulCommand([skipped], contract)).toBe(false);
    const printed = await run(
      "printf '%s\\n' 'uv run python check.py' fixture-check:ok",
    );
    expect(printed.item.exit_code).toBe(0);
    expect(successfulCommand([printed], contract)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

test("source check proof binds actual argv, current root/turn and canonical local cwd", () => {
  const cwd = "/fixture/project space";
  for (const command of [
    ["uv", "run", "python", "check.py"],
    [
      "/bin/zsh",
      "-lc",
      "cat calc.py && uv run --offline python check.py && pwd",
    ],
    ["bash", "-c", "UV_OFFLINE=1 uv run python check.py"],
  ])
    expect(
      successfulSourceCommand(sourceRecords(command, cwd), contract, cwd),
    ).toBe(true);
  const good = sourceRecords(
    ["/bin/zsh", "-lc", "uv run python check.py"],
    cwd,
  );
  for (const command of [
    "uv run python check.py",
    [],
    ["uv", null],
    ["uv", "run", "python", "other.py"],
    ["/tmp/zsh", "-lc", "uv run python check.py"],
    ["/bin/zsh", "-x", "-lc", "uv run python check.py"],
    ["/bin/zsh", "-lc", "bash -c 'uv run python check.py'"],
    ["/bin/zsh", "-lc", "uv run python check.py; true"],
    ["/bin/zsh", "-lc", "cd /decoy && uv run python check.py"],
    ["/bin/zsh", "-lc", "printf fixture-check:ok"],
    ["UV_OFFLINE=1", "uv", "run", "python", "check.py"],
    ["uv", "run", "python", "check.py", "&&", "pwd"],
  ]) {
    const records = structuredClone(good);
    records[3].payload.item.command = command;
    expect(
      successfulSourceCommand(records, contract, cwd),
      JSON.stringify(command),
    ).toBe(false);
  }
  for (const change of [
    { thread_id: "other" },
    { turn_id: "prior" },
    { type: "item_started" },
    { item: { ...good[3].payload.item, type: "command_execution" } },
    { item: { ...good[3].payload.item, status: "in_progress" } },
    { item: { ...good[3].payload.item, status: "failed" } },
    { item: { ...good[3].payload.item, exit_code: 9 } },
    { item: { ...good[3].payload.item, exit_code: "0" } },
    { item: { ...good[3].payload.item, id: "" } },
    {
      item: {
        ...good[3].payload.item,
        aggregated_output: "fixture-check:ok suffix\n",
      },
    },
  ]) {
    const records = structuredClone(good);
    Object.assign(records[3].payload, change);
    expect(successfulSourceCommand(records, contract, cwd)).toBe(false);
  }
  for (const change of [
    (r) => (r[0].type = "response_item"),
    (r) => (r[0].payload.id = "other"),
    (r) => (r[1].payload.turn_id = "next"),
    (r) => (r[2].payload.turn_id = "next"),
    (r) => r.splice(3, 0, structuredClone(r[3])),
    (r) => r.push({ type: "turn_context", payload: { turn_id: "next" } }),
    (r) =>
      r.push({
        type: "event_msg",
        payload: { type: "task_started", turn_id: "next" },
      }),
    (r) =>
      (r[3] = {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: JSON.stringify(r[3]),
        },
      }),
    (r) =>
      (r[3] = {
        type: "response_item",
        payload: { type: "function_call_output", output: JSON.stringify(r[3]) },
      }),
  ]) {
    const records = structuredClone(good);
    change(records);
    expect(successfulSourceCommand(records, contract, cwd)).toBe(false);
  }
  // A prior turn's genuine completed check is not proof for a later turn.
  const prior = [
    ...good,
    { type: "turn_context", payload: { turn_id: "next" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "next" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "next" } },
  ];
  expect(successfulSourceCommand(prior, contract, cwd)).toBe(false);
  const tooEarly = [good[0], good[3], good[1], good[2], good[4]];
  expect(successfulSourceCommand(tooEarly, contract, cwd)).toBe(false);
  const tooLate = [good[0], good[1], good[2], good[4], good[3]];
  expect(successfulSourceCommand(tooLate, contract, cwd)).toBe(false);
  for (const records of [null, [], [null]])
    expect(successfulSourceCommand(records, contract, cwd)).toBe(false);
});

test("source cwd proof rejects decoys, remote/ambiguous URLs and malformed paths", () => {
  const cwd = "/fixture/project space";
  const good = sourceRecords(["uv", "run", "python", "check.py"], cwd);
  for (const value of [
    "file:///decoy",
    "file://remote/fixture/project%20space",
    "file://localhost/fixture/project%20space",
    "file:/fixture/project%20space",
    "https://example.com/fixture/project%20space",
    "file:///fixture/project%20space?ignored",
    "file:///fixture/project%20space#ignored",
    "file:///fixture%2Fproject%20space",
    "file:///fixture/project%ZZspace",
    "file:///fixture/elsewhere/../project%20space",
    "file:///fixture/%2e/project%20space",
    "file:///fixture/elsewhere/%2e%2e/project%20space",
    "file:///fixture//project%20space",
    cwd,
    "",
    null,
    {},
  ]) {
    const records = structuredClone(good);
    records[3].payload.item.cwd = value;
    expect(successfulSourceCommand(records, contract, cwd), String(value)).toBe(
      false,
    );
  }
  for (const expected of [
    "",
    null,
    "fixture/project space",
    cwd + "/",
    cwd + "/../project space",
  ])
    expect(successfulSourceCommand(good, contract, expected)).toBe(false);
});

test("actual successful uv and npm decoy checks cannot verify the failing intended project", async () => {
  const temp = await mkdtemp(
    join(process.env.TMPDIR || tmpdir(), "source-command-"),
  );
  try {
    const root = await realpath(temp);
    const intended = join(root, "intended project"),
      decoy = join(root, "decoy project");
    for (const [cwd, passes] of [
      [intended, false],
      [decoy, true],
    ]) {
      await mkdir(cwd);
      await writeFile(
        join(cwd, "check.py"),
        passes ? 'print("fixture-check:ok")\n' : "raise SystemExit(9)\n",
      );
      await writeFile(
        join(cwd, "check.js"),
        passes ? 'console.log("fixture-check:ok");\n' : "process.exit(9);\n",
      );
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({ private: true, scripts: { test: "node check.js" } }),
      );
    }
    for (const [argv, checkContract] of [
      [
        [
          "/bin/zsh",
          "-lc",
          "uv run --no-project --offline --no-cache --no-python-downloads python -B check.py",
        ],
        contract,
      ],
      [["/bin/zsh", "-lc", "npm test"], { tool: "npm", script: "check.js" }],
    ]) {
      const run = async (cwd) => {
        const result = await boundedProcess(argv, {
          cwd,
          timeout: 30000,
          env: {
            ...process.env,
            TMPDIR: root,
            PYTHONDONTWRITEBYTECODE: "1",
            npm_config_cache: join(root, "npm-cache"),
          },
        });
        return {
          result,
          records: sourceRecords(
            argv,
            cwd,
            result.out + result.err,
            result.code,
          ),
        };
      };
      const success = await run(decoy);
      expect(success.result.code).toBe(0);
      expect(success.result.out).toContain("fixture-check:ok");
      expect(
        successfulSourceCommand(success.records, checkContract, decoy),
      ).toBe(true);
      expect(
        successfulSourceCommand(success.records, checkContract, intended),
      ).toBe(false);
      const failed = await run(intended);
      expect(failed.result.code).toBe(9);
      expect(
        successfulSourceCommand(failed.records, checkContract, intended),
      ).toBe(false);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 60000);

test("actual symlink-parent cwd cannot be mistaken for URL-normalized intended cwd", async () => {
  const temp = await mkdtemp(
    join(process.env.TMPDIR || tmpdir(), "source-dot-cwd-"),
  );
  try {
    const root = await realpath(temp),
      intended = join(root, "fixture"),
      decoy = join(root, "decoy/fixture");
    await mkdir(intended);
    await mkdir(decoy, { recursive: true });
    await mkdir(join(root, "decoy/deep"));
    await writeFile(join(intended, "check.py"), "raise SystemExit(9)\n");
    await writeFile(join(decoy, "check.py"), 'print("fixture-check:ok")\n');
    await symlink(join(root, "decoy/deep"), join(root, "link"));
    const ambiguous = join(root, "link") + "/../fixture";
    expect(await realpath(ambiguous)).toBe(decoy);
    const argv = [
      "uv",
      "run",
      "--no-project",
      "--offline",
      "--no-cache",
      "python",
      "-B",
      "check.py",
    ];
    const run = await boundedProcess(argv, {
      cwd: ambiguous,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(run.code).toBe(0);
    expect(run.out).toContain("fixture-check:ok");
    const records = sourceRecords(argv, decoy, run.out + run.err, run.code);
    records[3].payload.item.cwd = "file://" + ambiguous;
    expect(successfulSourceCommand(records, contract, intended)).toBe(false);
    records[3].payload.item.cwd =
      "file://" + ambiguous.replace("/../", "/%2e%2e/");
    expect(successfulSourceCommand(records, contract, intended)).toBe(false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
test("Effect activation case requires attributable skill and reference reads", async () => {
  const c = JSON.parse(
    await readFile(
      new URL("./fixtures/effect-activation.json", import.meta.url),
      "utf8",
    ),
  );
  expect(c.required).toEqual(["typescript", "typescript/effect"]);
  expect(c.forbidden).toContain("frontend-ui");
  expect(c.prompt).not.toMatch(/\$typescript|references\/effect/);
});
test("dispatch wrapper missing engine stops before importing or calling a model", async () => {
  const script = fileURLToPath(
    new URL("../scripts/check_skill_dispatch.py", import.meta.url),
  );
  const p = Bun.spawn(
    [
      "uv",
      "run",
      "--no-project",
      "python",
      script,
      "--engine-root",
      "/nonexistent-codex-engine",
      "plan",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await p.exited).not.toBe(0);
  expect(await new Response(p.stderr).text()).toContain(
    "Missing maintained skill evaluation engine",
  );
});

test("wrapper records initial hashes and rejects instruction drift", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(
    join(process.env.TMPDIR || tmpdir(), "dispatch-test-"),
  );
  try {
    const scripts = join(root, "engine/scripts"),
      home = join(root, "home"),
      output = join(root, "out");
    await mkdir(scripts, { recursive: true });
    await mkdir(home);
    await writeFile(join(home, "AGENTS.md"), "before\n");
    for (const name of ["activation_trace.py", "read_guidance.py"])
      await writeFile(join(scripts, name), "# fixture\n");
    await writeFile(
      join(scripts, "skill_evals.py"),
      `from pathlib import Path\nimport os\nREFERENCES={}\ndef load_cases(): return []\ndef main(args):\n    Path(args[args.index('--output-dir')+1]).mkdir()\n    (Path(os.environ['CODEX_HOME'])/'AGENTS.md').write_text('after\\n')\n    return 0\n`,
    );
    const script = fileURLToPath(
      new URL("../scripts/check_skill_dispatch.py", import.meta.url),
    );
    const p = Bun.spawn(
      [
        "uv",
        "run",
        "--no-project",
        "python",
        script,
        "--engine-root",
        join(root, "engine"),
        "run",
        "--output-dir",
        output,
      ],
      {
        env: { ...process.env, CODEX_HOME: home, PYTHONDONTWRITEBYTECODE: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await p.exited).toBe(1);
    const metadata = JSON.parse(
      await readFile(join(output, "dispatch-engine.json"), "utf8"),
    );
    expect(metadata.drift).toEqual(["globalAgents"]);
    expect(metadata.globalAgentsSha256).toBe(
      new Bun.CryptoHasher("sha256").update("before\n").digest("hex"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const phase of ["import", "load"])
  test(`wrapper rejects ${phase}-time engine drift before evaluation`, async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(
      join(process.env.TMPDIR || tmpdir(), "engine-drift-test-"),
    );
    try {
      const scripts = join(root, "engine/scripts"),
        home = join(root, "home");
      await mkdir(scripts, { recursive: true });
      await mkdir(home);
      await writeFile(join(home, "AGENTS.md"), "before\n");
      for (const name of ["activation_trace.py", "read_guidance.py"])
        await writeFile(join(scripts, name), "# fixture\n");
      const mutate =
        "Path(__file__).write_text(Path(__file__).read_text()+'\\n# changed during loading\\n')";
      const source = `from pathlib import Path\nREFERENCES={}\n${phase === "import" ? mutate : ""}\ndef load_cases():\n    ${phase === "load" ? mutate : "pass"}\n    return []\ndef main(args):\n    Path(${JSON.stringify(join(root, "model-called"))}).write_text('bad')\n    return 0\n`;
      await writeFile(join(scripts, "skill_evals.py"), source);
      const script = fileURLToPath(
        new URL("../scripts/check_skill_dispatch.py", import.meta.url),
      );
      const p = Bun.spawn(
        [
          "uv",
          "run",
          "--no-project",
          "python",
          script,
          "--engine-root",
          join(root, "engine"),
          "plan",
        ],
        {
          env: {
            ...process.env,
            CODEX_HOME: home,
            PYTHONDONTWRITEBYTECODE: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await p.exited).not.toBe(0);
      expect(await new Response(p.stderr).text()).toContain(
        "changed during engine loading",
      );
      expect(await readFile(join(scripts, "skill_evals.py"), "utf8")).toContain(
        "# changed during loading",
      );
      await expect(readFile(join(root, "model-called"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

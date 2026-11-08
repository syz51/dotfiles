// Live skill dispatch, per the Skills section of claude/CLAUDE.md: real sessions on
// fixture projects, scored from the Skill and Read calls they made. Opt in with
// RUN_CLAUDE_LIVE=1. Scenarios whose assertion needs only the first steps stop at a
// turn limit; the full skill run and the ordinary task run to completion.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertUnchanged, snapshot } from "./lib/filesystem.js";
import { guidanceEvidence, guidanceTargets, scoreGuidance } from "./lib/guidance.js";
import { HOME_CLAUDE, LIVE, liveSuite, TEARDOWN_TIMEOUT } from "./lib/live.js";
import { finalText, skillLoads } from "./lib/stream.js";

const suite = liveSuite("dispatch");
const skillDir = (name) => join(HOME_CLAUDE, "skills", name);

const TS_PACKAGE = {
  "package.json": '{"name":"fixture","private":true,"type":"module","devDependencies":{"typescript":"5.9.3"}}\n',
  "tsconfig.json": '{"compilerOptions":{"strict":true,"module":"nodenext","target":"es2023","noEmit":true},"include":["src"]}\n',
};
const RUST_CRATE = { "Cargo.toml": '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\n' };

// Skills each case must load (in order where `order` is set) and must not load.
const cases = [
  {
    name: "TypeScript work loads typescript",
    files: { ...TS_PACKAGE, "src/total.ts": 'export function total(values: number[]): number {\n  return values.reduce((sum, value) => sum + value, "0");\n}\n' },
    prompt: "Fix the type error in src/total.ts.",
    load: ["typescript"],
    avoid: ["rust"],
  },
  {
    name: "Rust work loads rust",
    files: { ...RUST_CRATE, "src/lib.rs": "pub fn longest(words: &[String]) -> &str {\n    let mut best = String::new();\n    for word in words {\n        if word.len() > best.len() {\n            best = word.clone();\n        }\n    }\n    &best\n}\n" },
    prompt: "Fix the compile error in src/lib.rs.",
    load: ["rust"],
    avoid: ["typescript"],
  },
  {
    name: "Tauri work loads frontend-ui before tauri",
    files: {
      "index.html": '<!doctype html>\n<html>\n  <body>\n    <input id="name" />\n    <button id="greet">Greet</button>\n    <p id="message"></p>\n    <script type="module" src="main.js"></script>\n  </body>\n</html>\n',
      "main.js": 'document.querySelector("#greet").addEventListener("click", () => {\n  // TODO: call the Rust side.\n});\n',
      "src-tauri/Cargo.toml": '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2024"\n\n[build-dependencies]\ntauri-build = "2"\n\n[dependencies]\ntauri = "2"\n',
      "src-tauri/tauri.conf.json": '{"productName":"fixture","identifier":"dev.example.fixture","build":{"frontendDist":"../"},"app":{"windows":[{"title":"Fixture"}],"withGlobalTauri":true}}\n',
      "src-tauri/build.rs": "fn main() {\n    tauri_build::build()\n}\n",
      "src-tauri/src/main.rs": 'fn main() {\n    tauri::Builder::default()\n        .run(tauri::generate_context!())\n        .expect("error while running tauri application");\n}\n',
    },
    prompt: "In this Tauri app, add a `greet(name)` command in src-tauri/src/main.rs and call it from main.js so the greeting appears in #message.",
    load: ["frontend-ui", "tauri"],
    order: true,
  },
  {
    name: "TSX work loads frontend-ui first, then typescript",
    files: {
      ...TS_PACKAGE,
      "src/Button.tsx": 'type ButtonProps = { label: string; onClick: () => void };\n\nexport function Button({ label, onClick }: ButtonProps) {\n  return <button type="button" onClick={onClick}>{label}</button>;\n}\n',
    },
    prompt: "Add a `disabled` prop to the Button component in src/Button.tsx that disables the button and dims it.",
    load: ["frontend-ui", "typescript"],
    order: true,
  },
  {
    name: "Vue work loads frontend-ui first",
    files: {
      "package.json": '{"name":"fixture","private":true,"type":"module","dependencies":{"vue":"3.5.22"}}\n',
      "src/Counter.vue": '<script setup>\nimport { ref } from "vue";\nconst count = ref(0);\n</script>\n\n<template>\n  <button type="button" @click="count++">Clicked {{ count }} times</button>\n</template>\n',
    },
    prompt: "Add a reset button to src/Counter.vue that sets the count back to zero.",
    first: "frontend-ui",
  },
  {
    name: "Checking a built page loads headless-browser",
    files: { "dist/index.html": "<!doctype html>\n<html><head><title>Fixture</title></head><body><h1>Built page</h1><script>console.log('ready')</script></body></html>\n" },
    prompt: "Check that the built page dist/index.html renders and logs no console errors.",
    load: ["headless-browser"],
    maxTurns: 2,
  },
  {
    name: "Asking whether a skill exists loads find-skills",
    prompt: "Is there an agent skill that can turn Markdown notes into a slide deck? Do not install anything.",
    load: ["find-skills"],
    maxTurns: 2,
  },
];

describe.skipIf(!LIVE)("live skill dispatch", () => {
  beforeAll(() => suite.setup());
  afterAll(() => suite.teardown(), TEARDOWN_TIMEOUT);

  for (const scenario of cases)
    test.concurrent(scenario.name, () => suite.scenario(scenario.name, async ({ fixture, session }) => {
      const run = await session({ cwd: fixture(scenario.files), prompt: scenario.prompt, maxTurns: scenario.maxTurns ?? 4 });
      const skills = skillLoads(run.events);
      for (const name of scenario.load ?? []) expect(skills, `${name} was not loaded`).toContain(name);
      for (const name of scenario.avoid ?? []) expect(skills, `${name} was loaded`).not.toContain(name);
      if (scenario.order) expect(skills.indexOf(scenario.load[0])).toBeLessThan(skills.indexOf(scenario.load[1]));
      if (scenario.first) expect(skills[0]).toBe(scenario.first);
    }), 400_000);

  // Also ports the visual-direction routing case: the frontend-ui skill has the visual
  // preferences file read before the recommendation, and no TypeScript guidance is involved.
  test.concurrent("chart work loads a data-visualization skill along with frontend-ui", () => suite.scenario("chart work", async ({ fixture, session }) => {
    const run = await session({
      cwd: fixture({ "brief.md": "A quiet personal reading dashboard for a web browser. Recommend a visual direction and an accessible chart for weekly completed books (week1: 2; week2: 5; week3: 3). Plain HTML/CSS is sufficient; no TypeScript is involved.\n" }),
      prompt: "Read brief.md and propose a visual direction and the chart approach for this web dashboard. Use the local brief and applicable guidance. Explain your recommendation only; do not implement, render, install, or modify anything.",
      maxTurns: 8,
    });
    const skills = skillLoads(run.events);
    expect(skills).toContain("frontend-ui");
    expect(skills.some((name) => /viz|visuali[sz]/i.test(name)), `no data-visualization skill in ${JSON.stringify(skills)}`).toBe(true);
    const targets = guidanceTargets({ preferences: join(HOME_CLAUDE, "frontend-avoid.md"), typescript: skillDir("typescript") });
    expect(scoreGuidance(guidanceEvidence(run.events, targets), {
      required: [{ target: "preferences" }],
      forbidden: [{ target: "typescript" }],
    })).toEqual([]);
    expect(skills).not.toContain("typescript");
  }), 400_000);

  // Guidance scope: the task reads the one routed reference it needs and nothing else.
  test.concurrent("an Effect review reads only the routed TypeScript reference", () => suite.scenario("effect guidance scope", async ({ fixture, session }) => {
    const run = await session({
      cwd: fixture({
        "package.json": '{"private":true,"type":"module"}\n',
        "src/workflow.ts": "export async function send(sendRequest: () => Promise<void>) { for (;;) { try { await sendRequest(); return; } catch {} } }\n",
      }),
      prompt: "Review this new TypeScript backend's proposed network workflow. Recommend the default application-logic approach from my applicable guidance and explain expected failures, safe retries, cancellation, and where execution belongs. Inspect the local proposal; do not install or run anything.",
      maxTurns: 8,
    });
    expect(skillLoads(run.events)).toContain("typescript");
    expect(skillLoads(run.events)).not.toContain("frontend-ui");
    const targets = guidanceTargets({ typescript: skillDir("typescript"), "frontend-ui": skillDir("frontend-ui") });
    const unrouted = ["references/tooling-and-public-types.md", "references/skill-map.md", "references/feedback.md"];
    for (const file of unrouted) expect(existsSync(join(skillDir("typescript"), file)), file).toBe(true);
    expect(scoreGuidance(guidanceEvidence(run.events, targets), {
      required: [{ target: "typescript", file: "references/effect.md" }],
      forbidden: [{ target: "frontend-ui" }, ...unrouted.map((file) => ({ target: "typescript", file }))],
    })).toEqual([]);
  }), 400_000);

  // Ordinary trace: unrelated work in a TypeScript and Rust repository loads no skill.
  test.concurrent("a README typo fix in a TypeScript and Rust repository loads no skill", () => suite.scenario("ordinary readme fix", async ({ fixture, session }) => {
    const readme = "# Fixture\n\nThis tool helps you recieve updates.\n";
    const work = fixture({
      ...TS_PACKAGE, ...RUST_CRATE,
      "src/index.ts": "export const greeting: string = \"hello\";\n",
      "src/lib.rs": "pub fn greeting() -> &'static str {\n    \"hello\"\n}\n",
      "README.md": readme,
    });
    const before = snapshot(work);
    const run = await session({ cwd: work, prompt: "Fix the typo in README.md." });
    expect(skillLoads(run.events)).toEqual([]);
    assertUnchanged(before, snapshot(work), ["README.md"]);
    expect(readFileSync(join(work, "README.md"), "utf8")).toBe(readme.replace("recieve", "receive"));
  }), 400_000);

  // Full skill run: content-research-writer drafts the article end to end and saves the
  // requested artifact from the supplied facts only.
  test.concurrent("drafting an article loads content-research-writer and saves the draft", () => suite.scenario("article draft", async ({ fixture, session }) => {
    const notes = "# Notes\n- The Riverside branch library opens at 8 a.m. on weekdays starting 3 March.\n- Weekend hours stay 10 a.m. to 4 p.m.\n- The new quiet study room seats 12 people and needs no booking.\n";
    const work = fixture({ "notes.md": notes });
    const before = snapshot(work);
    const run = await session({
      cwd: work,
      prompt: "Draft a short article of about 150 words for our team newsletter about the Riverside branch library's new hours, using only the facts in notes.md. Save it as article.md.",
    });
    expect(skillLoads(run.events)).toContain("content-research-writer");
    expect(existsSync(join(work, "article.md")), "article.md was not saved").toBe(true);
    const after = snapshot(work);
    delete after["article.md"];
    assertUnchanged(before, after);
    const article = readFileSync(join(work, "article.md"), "utf8");
    const words = article.split(/\s+/).filter(Boolean).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(300);
    for (const fact of [/8\s*a\.?m\.?/i, /3 March|March 3/i, /\b12\b/]) expect(article).toMatch(fact);
    expect(finalText(run.events)).toMatch(/article\.md/);
  }), 600_000);
});

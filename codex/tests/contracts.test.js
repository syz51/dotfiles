import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
const roles = {
  explorer: ["gpt-6.1-terra", "medium"],
  worker: ["gpt-6.1-sol", "medium"],
  solver: ["gpt-6.1-sol", "xhigh"],
  reviewer: ["gpt-6.1-sol", "xhigh"],
};
for (const [name, [model, effort]] of Object.entries(roles))
  test(`${name} retains its configured execution contract`, async () => {
    const role = Bun.TOML.parse(
      await readFile(
        new URL(`../agents/${name}.toml`, import.meta.url),
        "utf8",
      ),
    );
    expect(role.name).toBe(name);
    expect(role.model).toBe(model);
    expect(role.model_reasoning_effort).toBe(effort);
    expect(role.developer_instructions.trim().length).toBeGreaterThan(30);
  });
test("cleanup retains explicit high-consequence and mode safeguards", async () => {
  const source = await readFile(
    new URL("../AGENTS.md", import.meta.url),
    "utf8",
  );
  for (const concept of [
    /Fast[\s\S]*Ultra|Ultra[\s\S]*Fast/,
    /secrets/,
    /credentials/,
    /force-with-lease/,
    /default branch/,
    /production/,
    /external/,
    /read-only/,
  ])
    expect(source).toMatch(concept);
});

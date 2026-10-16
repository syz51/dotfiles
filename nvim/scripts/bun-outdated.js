export function parseOutdated(output, dependencies) {
  const names = new Map();
  for (const [name, version] of Object.entries(dependencies)) {
    const targets = [name];
    if (typeof version === "string" && version.startsWith("npm:")) {
      const target = version.slice(4);
      const separator = target.lastIndexOf("@");
      targets.push(separator > 0 ? target.slice(0, separator) : target);
    }
    for (const target of targets) {
      names.set(target, [...(names.get(target) ?? []), name]);
    }
  }

  const outdated = {};
  // shortcut: Bun has no JSON outdated output; replace this parser when it does.
  for (const line of output.split(/\r?\n/).map((line) => line.trim())) {
    if (!line || line.startsWith("bun outdated v") || /^[|+\-─┌┬┐└┴┘├┼┤│ ]+$/.test(line)) continue;
    const cells = line.split(/[|│]/).slice(1, -1).map((cell) => cell.trim());
    if (cells[0] === "Package" && cells[3] === "Latest") continue;
    if (cells.length < 4 || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(cells[3])) {
      throw new Error(`Unrecognized bun outdated output: ${line}`);
    }
    const name = cells[0].replace(/ \((?:dev|peer|optional)\)$/, "").split("@npm:")[0];
    for (const dependency of names.get(name) ?? [name]) {
      outdated[dependency] = { current: cells[1], wanted: cells[2], latest: cells[3] };
    }
  }
  return outdated;
}

if (import.meta.main) {
  const result = Bun.spawnSync([process.execPath, "outdated"], {
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdout: "pipe",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
  const manifest = await Bun.file("package.json").json();
  const dependencies = {
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
    ...manifest.dependencies,
  };
  console.log(JSON.stringify(parseOutdated(result.stdout.toString(), dependencies)));
}

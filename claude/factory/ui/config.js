// The climb configuration, a JSON file in the project: how to serve the app, the screens to
// capture, reference products, the judges and the pass bar. Relative paths resolve from the
// file's folder. Validated here once; everything after works with the normalized value.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

// Steps a screen runs after the page loads, as the headless-browser script's flags.
export const STEP_FLAGS = { click: "--click", hover: "--hover", fill: "--fill", press: "--press", scroll: "--scroll", wait: "--wait", waitFor: "--wait-for" };
const NUMERIC_STEPS = new Set(["scroll", "wait"]);
// A viewport narrower than this is a phone layout: the rubric's small-screen category and
// the tap-target check apply to it.
export const NARROW_WIDTH = 600;
// Images in one judge call: the API takes up to 100.
export const MAX_IMAGES = 90;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

// Scaled down and recolored so a judge that cannot tell it from the real design is not
// judging design: serif text, flat grey, square and dashed controls, cramped lines.
export const DEFAULT_CONTROL_CSS = [
  "*, *::before, *::after { font-family: 'Times New Roman', Times, serif !important; border-radius: 0 !important; box-shadow: none !important; letter-spacing: 0.03em !important; line-height: 1.1 !important; }",
  "body, body * { color: #8c8c8c !important; }",
  "h1, h2, h3, h4 { font-size: 14px !important; font-weight: 400 !important; }",
  "button, a, input, select, textarea, [role=button] { border: 1px dashed #a0a0a0 !important; background: transparent !important; }",
].join("\n");

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DEFAULT_VIEWPORTS = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } };

export class ConfigError extends Error {}

const fail = (file, message) => {
  throw new ConfigError(`${file}: ${message}`);
};

function argvList(file, value, where) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((argv) => Array.isArray(argv) && argv.length && argv.every((part) => typeof part === "string" && part)))
    fail(file, `${where} must be a list of commands, each a non-empty list of strings`);
  return value;
}

function text(file, value, where, { optional = false, max = 2000 } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) fail(file, `${where} must be a non-empty string of at most ${max} characters`);
  return value.trim();
}

function number(file, value, where, { min, max, integer = false, fallback }) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
    fail(file, `${where} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}`);
  return value;
}

function paths(file, value, where) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((path) => typeof path === "string" && path.startsWith("/")))
    fail(file, `${where} must be a list of paths starting with /`);
  return value;
}

// A view is <viewport>-<scheme>, such as desktop-light or phone-dark.
export function parseView(view, viewports) {
  const at = typeof view === "string" ? view.lastIndexOf("-") : -1;
  const name = at > 0 ? view.slice(0, at) : null;
  const viewport = name && Object.hasOwn(viewports, name) ? viewports[name] : undefined;
  const scheme = at > 0 ? view.slice(at + 1) : undefined;
  if (!viewport || (scheme !== "light" && scheme !== "dark")) return null;
  return { view, width: viewport.width, height: viewport.height, scheme, narrow: viewport.width < NARROW_WIDTH };
}

function views(file, value, where, viewports) {
  if (!Array.isArray(value) || !value.length) fail(file, `${where} must list at least one view such as "desktop-light"`);
  const parsed = value.map((view) => parseView(view, viewports) ?? fail(file, `${where}: "${view}" is not <viewport>-<light|dark> with a viewport from "viewports" (${Object.keys(viewports).join(", ")})`));
  if (new Set(value).size !== value.length) fail(file, `${where} lists a view twice`);
  return parsed;
}

function steps(file, value, where) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(file, `${where} must be a list`);
  return value.map((step, index) => {
    const keys = step && typeof step === "object" && !Array.isArray(step) ? Object.keys(step) : [];
    if (keys.length !== 1 || !Object.hasOwn(STEP_FLAGS, keys[0]))
      fail(file, `${where}[${index}] must have exactly one of ${Object.keys(STEP_FLAGS).join(", ")}`);
    const [kind] = keys;
    const arg = step[kind];
    if (NUMERIC_STEPS.has(kind) ? !(Number.isFinite(arg) && arg >= 0) : !(typeof arg === "string" && arg))
      fail(file, `${where}[${index}].${kind} must be ${NUMERIC_STEPS.has(kind) ? "a number of at least 0" : "a non-empty string"}`);
    if (kind === "fill" && !arg.includes("=")) fail(file, `${where}[${index}].fill must be SELECTOR=TEXT`);
    return { kind, arg: String(arg) };
  });
}

function uniqueIds(file, items, where) {
  const seen = new Set();
  for (const item of items) {
    if (typeof item?.id !== "string" || !ID.test(item.id)) fail(file, `${where}: id "${item?.id}" must be lowercase letters, digits and dashes`);
    if (seen.has(item.id)) fail(file, `${where}: id "${item.id}" is used twice`);
    seen.add(item.id);
  }
}

export function validateConfig(raw, file) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(file, "must hold a JSON object");
  if (raw.version !== 1) fail(file, `version must be 1 (got ${JSON.stringify(raw.version)})`);
  const known = new Set(["version", "name", "product", "taste", "root", "setup", "checks", "serve", "viewports", "screens", "references", "referenceCapture", "judges", "pass", "budgetUsd", "baseline", "settleMs", "control"]);
  for (const key of Object.keys(raw)) if (!known.has(key)) fail(file, `unknown field "${key}"`);
  const dir = dirname(file);
  if (typeof raw.name !== "string" || !ID.test(raw.name)) fail(file, "name must be lowercase letters, digits and dashes (it names the run folder)");

  const viewports = raw.viewports ?? DEFAULT_VIEWPORTS;
  if (typeof viewports !== "object" || Array.isArray(viewports) || !Object.keys(viewports).length) fail(file, "viewports must map names to { width, height }");
  for (const [id, size] of Object.entries(viewports)) {
    if (!ID.test(id) || id.includes("-")) fail(file, `viewport "${id}" must be lowercase letters and digits`);
    number(file, size?.width ?? null, `viewports.${id}.width`, { min: 240, max: 2000, integer: true });
    number(file, size?.height ?? null, `viewports.${id}.height`, { min: 240, max: 2000, integer: true });
  }

  const serve = raw.serve;
  if (!serve || typeof serve !== "object") fail(file, "serve must say how to start the app: { command, ready }");
  const [command] = argvList(file, [serve.command], "serve.command");
  if (!command.some((part) => part.includes("{port}"))) fail(file, "serve.command must contain {port}, replaced by a free port");

  if (!Array.isArray(raw.screens) || !raw.screens.length) fail(file, "screens must list at least one screen");
  uniqueIds(file, raw.screens, "screens");
  const screens = raw.screens.map((screen, index) => {
    const where = `screens[${index}] (${screen.id})`;
    if (typeof screen.path !== "string" || !screen.path.startsWith("/")) fail(file, `${where}.path must start with /`);
    return {
      id: screen.id,
      title: text(file, screen.title, `${where}.title`, { max: 120 }),
      path: screen.path,
      views: views(file, screen.views, `${where}.views`, viewports),
      steps: steps(file, screen.steps, `${where}.steps`),
      before: paths(file, screen.before, `${where}.before`),
      after: paths(file, screen.after, `${where}.after`),
    };
  });

  const references = raw.references ?? [];
  if (!Array.isArray(references)) fail(file, "references must be a list");
  uniqueIds(file, references, "references");
  const refs = references.map((ref, index) => {
    const where = `references[${index}] (${ref.id})`;
    const title = text(file, ref.title, `${where}.title`, { max: 120 });
    if ((ref.url === undefined) === (ref.files === undefined)) fail(file, `${where} needs either url (with views) or files`);
    if (ref.url !== undefined) {
      if (typeof ref.url !== "string" || !/^https?:\/\//.test(ref.url)) fail(file, `${where}.url must be an http or https URL`);
      return { id: ref.id, title, url: ref.url, views: views(file, ref.views, `${where}.views`, viewports), steps: steps(file, ref.steps, `${where}.steps`) };
    }
    if (!Array.isArray(ref.files) || !ref.files.length) fail(file, `${where}.files must list { path, view }`);
    return {
      id: ref.id, title, steps: [],
      files: ref.files.map((entry, at) => {
        const path = resolve(dir, typeof entry?.path === "string" ? entry.path : fail(file, `${where}.files[${at}].path must be a string`));
        if (!IMAGE_TYPES[extname(path).toLowerCase()]) fail(file, `${where}.files[${at}]: ${path} must be PNG, JPEG or WebP`);
        if (!existsSync(path)) fail(file, `${where}.files[${at}]: ${path} does not exist`);
        const view = parseView(entry.view, viewports) ?? fail(file, `${where}.files[${at}].view must be <viewport>-<light|dark>`);
        return { path, ...view };
      }),
    };
  });

  if (!Array.isArray(raw.judges) || !raw.judges.length) fail(file, "judges must list at least one { model, effort, samples }");
  const judges = raw.judges.map((judge, index) => ({
    model: text(file, judge?.model, `judges[${index}].model`, { max: 80 }),
    effort: judge?.effort === undefined ? "medium" : EFFORTS.includes(judge.effort) ? judge.effort : fail(file, `judges[${index}].effort must be one of ${EFFORTS.join(", ")}`),
    samples: number(file, judge?.samples, `judges[${index}].samples`, { min: 1, max: 5, integer: true, fallback: 2 }),
  }));
  if (new Set(judges.map((judge) => `${judge.model}@${judge.effort}`)).size !== judges.length) fail(file, "judges lists the same model and effort twice");

  const pass = raw.pass ?? {};
  if (pass.allReferences !== undefined && typeof pass.allReferences !== "boolean") fail(file, "pass.allReferences must be true or false");
  const referenceCapture = raw.referenceCapture ?? {};
  if (typeof referenceCapture !== "object" || Array.isArray(referenceCapture)) fail(file, "referenceCapture must be { tries, delayMs }");
  const budget = raw.budgetUsd ?? {};
  const control = raw.control ?? {};
  const taste = raw.taste ?? [];
  if (!Array.isArray(taste)) fail(file, "taste must be a list of strings");

  const config = {
    name: raw.name,
    product: text(file, raw.product, "product"),
    taste: taste.map((item, index) => text(file, item, `taste[${index}]`, { max: 300 })),
    rootDir: resolve(dir, typeof raw.root === "string" ? raw.root : raw.root === undefined ? "." : fail(file, "root must be a path")),
    setup: argvList(file, raw.setup, "setup"),
    checks: argvList(file, raw.checks, "checks"),
    serve: {
      command,
      ready: serve.ready === undefined ? "/" : typeof serve.ready === "string" && serve.ready.startsWith("/") ? serve.ready : fail(file, "serve.ready must be a path starting with /"),
      timeoutMs: number(file, serve.timeoutMs, "serve.timeoutMs", { min: 1000, max: 600_000, integer: true, fallback: 60_000 }),
    },
    viewports,
    screens,
    references: refs,
    // A reference page that fails to capture is tried again, waiting delayMs, then twice
    // as long before each later try.
    referenceCapture: {
      tries: number(file, referenceCapture.tries, "referenceCapture.tries", { min: 1, max: 10, integer: true, fallback: 3 }),
      delayMs: number(file, referenceCapture.delayMs, "referenceCapture.delayMs", { min: 0, max: 600_000, integer: true, fallback: 30_000 }),
    },
    judges,
    pass: {
      min: number(file, pass.min, "pass.min", { min: 1, max: 10, fallback: 8.5 }),
      gain: number(file, pass.gain, "pass.gain", { min: 0, max: 9, fallback: 0.5 }),
      references: pass.references === null || pass.references === undefined ? null : number(file, pass.references, "pass.references", { min: -9, max: 9 }),
      // A pass judged while a reference did not capture is provisional, not final.
      allReferences: pass.allReferences ?? true,
    },
    budgetUsd: {
      call: number(file, budget.call, "budgetUsd.call", { min: 0.01, max: 100, fallback: 2 }),
      round: number(file, budget.round, "budgetUsd.round", { min: 0.01, max: 1000, fallback: 15 }),
      run: number(file, budget.run, "budgetUsd.run", { min: 0.01, max: 10_000, fallback: 100 }),
    },
    baseline: raw.baseline === undefined ? "origin/main" : text(file, raw.baseline, "baseline", { max: 200 }),
    settleMs: number(file, raw.settleMs, "settleMs", { min: 0, max: 10_000, integer: true, fallback: 300 }),
    controlCss: control.css === undefined ? DEFAULT_CONTROL_CSS : text(file, control.css, "control.css", { max: 10_000 }),
  };
  if (config.budgetUsd.call > config.budgetUsd.round) fail(file, "budgetUsd.call must not exceed budgetUsd.round");
  const images = 2 * productShots(config).length + referenceShots(config).length;
  if (images > MAX_IMAGES) fail(file, `a judge call would carry ${images} images (two versions of every screen view plus the references); keep it at most ${MAX_IMAGES}`);
  return config;
}

export function loadConfig(path) {
  const file = resolve(path);
  if (!existsSync(file)) throw new ConfigError(`${file} does not exist: write one (the ui-climb skill has a template) or pass --config`);
  const source = readFileSync(file, "utf8");
  let raw;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON: ${error.message}`);
  }
  // The hash of the parsed value, so formatting does not count as a change; a run is tied
  // to the configuration it started with.
  return { ...validateConfig(raw, file), file, hash: createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 16) };
}

// The product's screenshots: one per screen and view, named <screen>.<view>.
export const productShots = (config) => config.screens.flatMap((screen) => screen.views.map((view) => ({
  id: `${screen.id}.${view.view}`, screen: screen.id, title: screen.title, path: screen.path, steps: screen.steps,
  before: screen.before, after: screen.after, ...view,
})));

// The references' screenshots, named <reference>.<view> (or .<n> for several files of one view).
export const referenceShots = (config) => config.references.flatMap((ref) => ref.url
  ? ref.views.map((view) => ({ id: `${ref.id}.${view.view}`, ref: ref.id, title: ref.title, url: ref.url, steps: ref.steps, ...view }))
  : ref.files.map((entry, index) => ({ id: `${ref.id}.${entry.view}${ref.files.filter((other) => other.view === entry.view).length > 1 ? `.${index + 1}` : ""}`, ref: ref.id, title: ref.title, file: entry.path, ...entry })));

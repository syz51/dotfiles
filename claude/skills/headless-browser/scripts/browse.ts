#!/usr/bin/env bun
// Drive a headless Chromium: open a page, run steps in order, save screenshots,
// and report what the page logged. Prints one JSON object on stdout.

import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const HELP = `usage: browse.ts <url> [options] [steps...]

options
  --width N          viewport width (default 1280)
  --height N         viewport height (default 900)
  --scale N          device scale factor (default 1)
  --scheme S         prefers-color-scheme: light or dark
  --reduced-motion   emulate prefers-reduced-motion: reduce
  --timeout MS       timeout for navigation and each step (default 15000)
  --strict           exit 1 when the page threw or logged an error

steps, run in the order given
  --click SEL        click an element (CSS or Playwright selector)
  --hover SEL        hover an element
  --fill SEL=TEXT    fill an input
  --press KEY        press a key, e.g. Enter, ArrowRight, Meta+k
  --scroll Y         scroll the window to Y pixels
  --wait MS          sleep
  --wait-for SEL     wait until an element is visible
  --goto URL         navigate again
  --eval JS          evaluate an expression; its value is reported
  --shot [PATH]      screenshot the viewport
  --full [PATH]      screenshot the whole page
  --element SEL[=PATH]  screenshot one element

With no --shot, --full or --element step, one viewport screenshot is taken at
the end. PATH defaults to a numbered PNG in $TMPDIR/headless-browser/.`;

type Step = { kind: string; arg?: string };

const args = process.argv.slice(2);
if (!args.length || args[0] === '-h' || args[0] === '--help') {
  console.log(HELP);
  process.exit(args.length ? 0 : 2);
}

// Check for the pinned install first: without node_modules, Bun would quietly
// auto-install an unpinned Playwright whose browser build may not be present.
if (!existsSync(join(import.meta.dir, '..', 'node_modules', 'playwright'))) {
  console.error(`playwright is not installed. Run: sh ${join(import.meta.dir, 'setup.sh')}`);
  process.exit(3);
}
const playwright = await import('playwright');

const opts = { width: 1280, height: 900, scale: 1, scheme: undefined as 'light' | 'dark' | undefined, reducedMotion: false, timeout: 15000, strict: false };
const steps: Step[] = [];
let url = '';
const takesArg = new Set(['click', 'hover', 'fill', 'press', 'scroll', 'wait', 'wait-for', 'goto', 'eval', 'element']);
const optionalArg = new Set(['shot', 'full']);

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) {
    if (url) fail(`unexpected argument: ${a}`);
    url = a;
    continue;
  }
  const name = a.slice(2);
  const next = () => {
    const v = args[++i];
    if (v === undefined) fail(`--${name} needs a value`);
    return v;
  };
  switch (name) {
    case 'width': opts.width = Number(next()); break;
    case 'height': opts.height = Number(next()); break;
    case 'scale': opts.scale = Number(next()); break;
    case 'scheme': {
      const v = next();
      if (v !== 'light' && v !== 'dark') fail('--scheme takes light or dark');
      opts.scheme = v;
      break;
    }
    case 'reduced-motion': opts.reducedMotion = true; break;
    case 'timeout': opts.timeout = Number(next()); break;
    case 'strict': opts.strict = true; break;
    default:
      if (takesArg.has(name)) steps.push({ kind: name, arg: next() });
      else if (optionalArg.has(name)) {
        const v = args[i + 1];
        steps.push({ kind: name, arg: v !== undefined && !v.startsWith('--') ? args[++i] : undefined });
      } else fail(`unknown option: ${a}`);
  }
}
if (!url) fail('missing url');
if (!/^[a-z]+:/i.test(url)) url = /^(localhost|127\.|\[::1\])/.test(url) ? `http://${url}` : `https://${url}`;
if (!steps.some((s) => ['shot', 'full', 'element'].includes(s.kind))) steps.push({ kind: 'shot' });

const outDir = join(process.env.TMPDIR ?? tmpdir(), 'headless-browser');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
let shotCount = 0;
const shotPath = (p?: string) => {
  const out = p ? resolve(p) : join(outDir, `${stamp}-${++shotCount}.png`);
  mkdirSync(dirname(out), { recursive: true });
  return out;
};

const report = {
  url: '',
  title: '',
  status: null as number | null,
  screenshots: [] as string[],
  evals: [] as { expression: string; value: unknown }[],
  pageErrors: [] as string[],
  consoleErrors: [] as string[],
  consoleWarnings: [] as string[],
  failedRequests: [] as string[],
  error: null as string | null,
};

const browser = await playwright.chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: opts.scale,
    colorScheme: opts.scheme,
    reducedMotion: opts.reducedMotion ? 'reduce' : undefined,
  });
  page.setDefaultTimeout(opts.timeout);
  page.on('pageerror', (e) => report.pageErrors.push(e.stack ?? String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') report.consoleErrors.push(m.text());
    else if (m.type() === 'warning') report.consoleWarnings.push(m.text());
  });
  page.on('requestfailed', (r) => report.failedRequests.push(`${r.failure()?.errorText ?? 'failed'} ${r.url()}`));
  page.on('response', (r) => {
    if (r.status() >= 400) report.failedRequests.push(`${r.status()} ${r.url()}`);
  });

  const res = await page.goto(url, { waitUntil: 'load', timeout: opts.timeout });
  report.status = res?.status() ?? null;

  for (const s of steps) {
    const arg = s.arg ?? '';
    switch (s.kind) {
      case 'click': await page.click(arg); break;
      case 'hover': await page.hover(arg); break;
      case 'fill': {
        const at = arg.indexOf('=');
        if (at < 0) throw new Error('--fill takes SEL=TEXT');
        await page.fill(arg.slice(0, at), arg.slice(at + 1));
        break;
      }
      case 'press': await page.keyboard.press(arg); break;
      case 'scroll': await page.evaluate((y) => window.scrollTo(0, y), Number(arg)); break;
      case 'wait': await page.waitForTimeout(Number(arg)); break;
      case 'wait-for': await page.waitForSelector(arg, { state: 'visible' }); break;
      case 'goto': await page.goto(arg, { waitUntil: 'load' }); break;
      case 'eval': {
        const value = await page.evaluate((src) => {
          // eslint-disable-next-line no-eval
          const v = (0, eval)(src);
          return Promise.resolve(v).then((x) => JSON.parse(JSON.stringify(x ?? null)));
        }, arg);
        report.evals.push({ expression: arg, value });
        break;
      }
      case 'shot':
      case 'full': {
        const out = shotPath(s.arg);
        await page.screenshot({ path: out, fullPage: s.kind === 'full' });
        report.screenshots.push(out);
        break;
      }
      case 'element': {
        const at = arg.lastIndexOf('=');
        const hasPath = at > 0 && /\.png$/i.test(arg.slice(at + 1));
        const sel = hasPath ? arg.slice(0, at) : arg;
        const out = shotPath(hasPath ? arg.slice(at + 1) : undefined);
        await page.locator(sel).first().screenshot({ path: out });
        report.screenshots.push(out);
        break;
      }
    }
  }
  report.url = page.url();
  report.title = await page.title();
} catch (e) {
  report.error = e instanceof Error ? e.message.split('\n')[0] : String(e);
} finally {
  await browser.close();
}

console.log(JSON.stringify(report, null, 2));
const broken = report.pageErrors.length + report.consoleErrors.length > 0;
process.exit(report.error ? 1 : opts.strict && broken ? 1 : 0);

function fail(msg: string): never {
  console.error(`${msg}\n\n${HELP}`);
  process.exit(2);
}

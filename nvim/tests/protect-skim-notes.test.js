import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The TeX build runs this guard before every compile; check its boundaries
// without driving Skim itself.
const script = join(import.meta.dir, "../scripts/protect-skim-notes.js");
const bundleId = "net.sourceforge.skim-app.skim";
const macOS = process.platform === "darwin";
const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "skim-guard-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function guard(...args) {
  const result = Bun.spawnSync(["osascript", "-l", "JavaScript", script, ...args], { stderr: "pipe" });
  return { code: result.exitCode, stderr: result.stderr.toString() };
}

function skimRunning() {
  const probe = `ObjC.import("AppKit"); ObjC.unwrap($.NSRunningApplication.runningApplicationsWithBundleIdentifier("${bundleId}")).length`;
  return Bun.spawnSync(["osascript", "-l", "JavaScript", "-e", probe]).stdout.toString().trim() !== "0";
}

// A one-page PDF with no annotations, with a correct cross-reference table.
function writePdf(path) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(path, body);
}

test.skipIf(!macOS)("rejects a non-PDF output path", () => {
  const result = guard(join(scratch, "paper.tex"));
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("Expected a PDF output path");
});

test.skipIf(!macOS)("allows the first build, before any PDF exists", () => {
  expect(guard(join(scratch, "missing.pdf")).code).toBe(0);
});

// Skim being installed or not makes no difference when it is not running; the
// guard used to throw where Skim was not installed, blocking every build.
test.skipIf(!macOS || skimRunning())("allows a rebuild while Skim is not running", () => {
  const pdf = join(scratch, "paper.pdf");
  writePdf(pdf);
  expect(guard(pdf)).toEqual({ code: 0, stderr: "" });
});

test("detects Skim by its real bundle identifier", () => {
  expect(readFileSync(script, "utf8")).toContain(`"${bundleId}"`);
  const plist = "/Applications/Skim.app/Contents/Info.plist";
  const result = Bun.spawnSync(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleIdentifier", plist]);
  if (result.exitCode === 0) expect(result.stdout.toString().trim()).toBe(bundleId);
});

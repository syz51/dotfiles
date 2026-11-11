// One table of git's global-option forms, run against both git guards: each must find the
// subcommand after every form, and never take an option's value for the subcommand.
import { describe, expect, test } from "bun:test";
import { findViolation } from "./guard-git-push.js";
import { findMainCheckoutViolation } from "./guard-main-checkout.js";

// `{v}` is the option's value word, when it takes one. `otherRepo` forms name another
// repository, which guard-main-checkout cannot tell is a main checkout.
const FORMS = [
  { form: "-C {v}", value: "." },
  { form: "-c {v}", value: "core.pager=cat" },
  { form: "--config-env {v}", value: "core.pager=PAGER" },
  { form: "--config-env=core.pager=PAGER" },
  { form: "--git-dir {v}", value: ".git", otherRepo: true },
  { form: "--git-dir=.git", otherRepo: true },
  { form: "--work-tree {v}", value: ".", otherRepo: true },
  { form: "--work-tree=.", otherRepo: true },
  { form: "--namespace {v}", value: "ns" },
  { form: "--namespace=ns" },
  { form: "--super-prefix=sub/" },
  { form: "--attr-source {v}", value: "HEAD" },
  { form: "--exec-path=/usr/libexec/git-core" },
  { form: "--exec-path" },
  { form: "--no-pager" },
  { form: "-p" },
];
const spell = ({ form, value }, word = value) => form.replace("{v}", word);

// /main is a clean main checkout on main, and the push guard's checkout is on feature.
function mainGit(dir, args) {
  if (dir !== "/main") return undefined;
  if (args[0] === "rev-parse") return "/main/.git\n/main/.git\n/main";
  if (args[0] === "symbolic-ref") return "origin/main";
  if (args[0] === "status") return "# branch.oid abc\n# branch.head main";
  return undefined;
}
function pushGit(dir, args) {
  if (args.join(" ") === "symbolic-ref --quiet --short HEAD") return "feature";
  if (args[0] === "symbolic-ref") return "origin/main";
  return undefined;
}
const mainVerdict = (command) => findMainCheckoutViolation(command, "/main", mainGit, []);
const pushVerdict = (command) => findViolation(command, "/main", pushGit);

describe.each(FORMS.map((form) => [spell(form), form]))("git %s", (_, form) => {
  test("guard-git-push finds the push after it", () => {
    expect(pushVerdict(`git ${spell(form)} push --force origin main`)).toContain("default branch");
  });
  test("guard-main-checkout finds the switch after it", () => {
    const verdict = mainVerdict(`git ${spell(form)} switch other`);
    if (form.otherRepo) expect(verdict).toBeUndefined();
    else expect(verdict).toContain("main checkout other threads share");
  });
  if (form.value !== undefined) {
    test("neither guard reads its value as the subcommand", () => {
      expect(pushVerdict(`git ${spell(form, "push")} status --force origin main`)).toBeUndefined();
      expect(mainVerdict(`git ${spell(form, "switch")} status other`)).toBeUndefined();
    });
  }
});

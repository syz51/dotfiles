#!/usr/bin/env python3
"""PreToolUse hook: ask before destructive Bash commands, including in bypass mode.

Claude Code and Codex send the same payload. Codex cannot ask, so its hook passes --deny and
the agent leaves the command for the user. Detection is best effort for commands an agent
writes in good faith, not a security boundary.
Recursive rm skips confirmation only when every operand resolves strictly inside a
temporary root (/tmp, /private/tmp, or TMPDIR), with no unresolved shell expansion.
"""

import json
import os
import re
import shlex
import sys

PUNCTUATION = ";&|()"
WRAPPERS = {"command", "env", "exec", "nice", "nohup", "time", "xargs"}
SHELLS = {"bash", "dash", "sh", "zsh"}
GIT_OPTIONS_WITH_VALUE = {"-C", "-c", "--git-dir", "--namespace", "--work-tree"}
ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")
SHORT_FLAGS = re.compile(r"-[A-Za-z]+")
TMPDIR_VARIABLE = re.compile(r"^\$(?:TMPDIR(?=/|$)|\{TMPDIR\})")
SHELL_WORD = re.compile(r'''(?:[^\s;&|()'"\\]+|'[^']*'|"(?:\\.|[^"\\])*"|\\.)+''', re.S)
# Used only when the command cannot be tokenized, such as a heredoc body with an apostrophe.
FALLBACK = re.compile(
    r"\brm\s+(-\S*[rR]|--recursive)"
    r"|\bgit\b.*\b(push\b.*(--force|--delete|\s-[a-z]*[fd]\b|\s\+)|reset\b.*--hard|clean\b|stash\s+(drop|clear))"
    r"|\bsudo\b|\bfind\b.*\s-delete\b"
)


def segments(command):
    lexer = shlex.shlex(command.replace("\n", " ; "), posix=True, punctuation_chars=PUNCTUATION)
    lexer.whitespace_split = True
    segment = []
    for token in lexer:
        if set(token) <= set(PUNCTUATION):
            if segment:
                yield segment
            segment = []
        else:
            segment.append(token)
    if segment:
        yield segment


def short_flags(args):
    return "".join(arg[1:] for arg in args if SHORT_FLAGS.fullmatch(arg))


def rm_operands(args):
    operands = []
    options = True
    for arg in args:
        if options and arg == "--":
            options = False
        elif not options or not arg.startswith("-") or arg == "-":
            operands.append(arg)
    return operands


def scratch_unsafe_segments(command):
    # shlex drops quoting: a quoted separator or literal variable must not grant an exemption.
    unsafe = set()
    for match in SHELL_WORD.finditer(command):
        raw = match.group(0)
        words = shlex.split(raw)
        if not words:
            continue
        word = words[0]
        separator = set(word) <= set(PUNCTUATION)
        literal_variable = TMPDIR_VARIABLE.match(word) and not TMPDIR_VARIABLE.match(raw.removeprefix('"'))
        if separator or literal_variable:
            # The prefix identifies the affected segment without changing existing tokenization.
            prefix = list(segments(command[: match.start()]))
            if prefix:
                unsafe.add(len(prefix) - 1)
    return unsafe


def scratch_path(path):
    tmpdir = os.environ.get("TMPDIR")
    variable = TMPDIR_VARIABLE.match(path)
    if variable:
        if not tmpdir:
            return False
        path = tmpdir + path[variable.end() :]
    if any(char in path for char in "$`~*?[]{}") or not os.path.isabs(path):
        return False
    resolved = os.path.realpath(path)
    roots = ["/tmp", "/private/tmp"] + ([tmpdir] if tmpdir else [])
    roots = [os.path.realpath(root) for root in roots]
    allowed_roots = [os.path.realpath(tmpdir)] if variable else roots
    return resolved not in roots and any(os.path.commonpath([root, resolved]) == root for root in allowed_roots)


def git_reason(args):
    i = 0
    while i < len(args) and args[i].startswith("-"):
        i += 2 if args[i] in GIT_OPTIONS_WITH_VALUE else 1
    if i >= len(args):
        return None
    sub, rest = args[i], args[i + 1 :]
    flags = short_flags(rest)
    if sub == "push" and (
        any(arg.startswith(("--force", "--delete", "--mirror")) for arg in rest)
        or "f" in flags
        or "d" in flags
        or any(arg.startswith(("+", ":")) for arg in rest)
    ):
        return "git push that forces or deletes"
    if sub == "reset" and "--hard" in rest:
        return "git reset --hard"
    if sub == "clean" and not ("n" in flags or "--dry-run" in rest):
        return "git clean"
    if sub == "checkout" and ("--" in rest or "." in rest or "f" in flags or "--force" in rest):
        return "git checkout that discards changes"
    if sub == "restore" and not (("--staged" in rest or "S" in flags) and not ("--worktree" in rest or "W" in flags)):
        return "git restore of working-tree files"
    if sub == "branch" and ("D" in flags or ("--delete" in rest or "d" in flags) and ("--force" in rest or "f" in flags)):
        return "git branch force delete"
    if sub == "stash" and rest[:1] in (["drop"], ["clear"]):
        return f"git stash {rest[0]}"
    return None


def segment_reason(tokens, depth, scratch_allowed=True):
    while tokens and (tokens[0] in WRAPPERS or tokens[0] == "sudo" or ASSIGNMENT.match(tokens[0])):
        if tokens[0] == "sudo":
            return "sudo"
        if tokens[0] in {"env", "xargs"} or tokens[0].startswith("TMPDIR="):
            scratch_allowed = False
        tokens = tokens[1:]
        while tokens and tokens[0].startswith("-"):
            tokens = tokens[1:]
    if not tokens:
        return None
    name, args = tokens[0].rsplit("/", 1)[-1], tokens[1:]
    if name == "rm" and ("--recursive" in args or any(c in "rR" for c in short_flags(args))):
        operands = rm_operands(args)
        return None if scratch_allowed and operands and all(scratch_path(path) for path in operands) else "recursive rm"
    if name == "find":
        if "-delete" in args:
            return "find -delete"
        for flag in ("-exec", "-execdir", "-ok"):
            if flag in args:
                found = segment_reason(args[args.index(flag) + 1 :], depth, scratch_allowed)
                if found:
                    return found
    if name == "git":
        return git_reason(args)
    if name == "gh" and (
        (len(args) >= 2 and args[1] == "delete")
        or (args[:1] == ["api"] and re.search(r"(-X|--method)\s*=?\s*DELETE", " ".join(args), re.I))
    ):
        return "gh delete"
    if name == "dd" and any(arg.startswith("of=") for arg in args):
        return "dd write"
    if name.startswith("mkfs") or (name == "diskutil" and args[:1] and args[0].lower().startswith(("erase", "zero", "random", "secure", "partition"))):
        return "disk erase"
    if name in SHELLS or name == "eval":
        script = " ".join(args) if name == "eval" else next(
            (args[i + 1] for i, arg in enumerate(args[:-1]) if re.fullmatch(r"-[a-z]*c", arg)), None
        )
        if script and depth < 3:
            return command_reason(script, depth + 1, scratch_allowed)
    return None


def command_reason(command, depth=0, scratch_allowed=True):
    try:
        parsed = list(segments(command))
    except ValueError:
        match = FALLBACK.search(command)
        return f"unparsed command matching {match.group(0).strip()!r}" if match else None
    try:
        unsafe = scratch_unsafe_segments(command)
    except ValueError:
        # A failed exemption check must preserve all of the original destructive rules.
        unsafe = set(range(len(parsed)))
    if any(
        any(token.startswith("TMPDIR=") for token in tokens)
        or (tokens[0] in {"unset", "read", "export", "declare", "typeset", "local"} and "TMPDIR" in tokens[1:])
        for tokens in parsed
    ):
        scratch_allowed = False
    for index, tokens in enumerate(parsed):
        found = segment_reason(tokens, depth, scratch_allowed and index not in unsafe)
        if found:
            return found
    return None


def main():
    payload = json.load(sys.stdin)
    reason = command_reason(payload.get("tool_input", {}).get("command", ""))
    if not reason:
        return
    if "--deny" in sys.argv[1:]:
        decision = "deny"
        message = f"Blocked destructive command ({reason}). Do not work around this; leave it undone and list it in your final report for the user to approve."
    else:
        decision = "ask"
        message = f"Destructive command ({reason}); confirm before running."
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": decision,
                "permissionDecisionReason": message,
            }
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()

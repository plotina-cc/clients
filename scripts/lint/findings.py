#!/usr/bin/env python3
"""Diff-scoped lint reporting: which lint findings belong to *our* patches.

A lint gate on a patched upstream tree has one failure mode that matters more
than a missed rule: it goes red on lines we never wrote, somebody silences it,
and from then on it checks nothing. Our patches touch 30-60 files per client and
those files are upstream's, so a file-scoped linter reports upstream's floating
promises and upstream's empty catches next to ours.

So findings are split by line, not by file:

  ours      a finding on a line a patch adds or rewrites    -> fails the gate
  upstream  a finding on an untouched line of a patched file -> printed, ignored

Both halves are printed. The upstream half is why the numbers in the lint report
are not "0 issues": it is the noise we deliberately do not gate on, and it stays
visible so it cannot quietly grow.

Two subcommands, both driven by scripts/lint-patches.sh:

  findings.py added <tree>      print `<path>\\t<ranges>` for every file the
                                patches changed, ranges = new-file line numbers
                                of added/rewritten lines, as `a-b,c` (1-based)
  findings.py report --format F --added <file> --label <client/stack>
                     [--rule CODE ...] [--root DIR ...]
                                read a linter's machine output on stdin, print
                                our findings and count the upstream ones;
                                exit 1 when at least one finding is ours.
                                --rule keeps only the codes the gate owns;
                                --root is a tree the linter ran in (paths in the
                                report are made relative to it).

Formats: eslint (json), shellcheck (json1), dart (machine), detekt (txt).

Run as a file. The guard in this environment blocks `python3 -c`.
"""
import json
import os
import re
import subprocess
import sys


# --- added lines ------------------------------------------------------------------------------


def tracked_diff(tree):
    """Unified diff, zero context, of everything the patches changed in <tree>.

    The patches are applied to a real checkout of the upstream tag, so the diff
    against the index after `git add -A` *is* our change set: no patch-file
    parsing, no assumption about hunk headers, and a patch that stops applying is
    already refused by apply-patches.sh before we get here.
    """
    subprocess.run(["git", "-C", tree, "add", "-A"], check=True)
    return subprocess.run(
        ["git", "-C", tree, "diff", "--cached", "--unified=0", "--no-color", "--no-ext-diff"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout


HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def added_ranges(diff_text):
    """{path: [[start, end], ...]} of added/rewritten lines in the new file."""
    files = {}
    path = None
    for line in diff_text.splitlines():
        if line.startswith("+++ "):
            target = line[4:].strip()
            path = None if target == "/dev/null" else re.sub(r"^b/", "", target)
            if path:
                files.setdefault(path, [])
            continue
        m = HUNK.match(line)
        if m and path:
            start = int(m.group(1))
            count = 1 if m.group(2) is None else int(m.group(2))
            # count == 0 is a pure deletion: the hunk adds no line, so it can
            # carry no finding. Recording the start line instead would blame a
            # neighbour that the patch did not touch.
            if count > 0:
                files[path].append([start, start + count - 1])
    return {p: r for p, r in files.items() if r}


def cmd_added(args):
    if len(args) != 1:
        print("usage: findings.py added <tree>", file=sys.stderr)
        return 2
    ranges = added_ranges(tracked_diff(args[0]))
    for path in sorted(ranges):
        spans = ",".join(f"{a}-{b}" for a, b in ranges[path])
        print(f"{path}\t{spans}")
    return 0


# --- findings ---------------------------------------------------------------------------------


def parse_eslint(raw):
    findings = []
    for file_report in json.loads(raw or "[]"):
        path = file_report.get("filePath") or ""
        for msg in file_report.get("messages", []):
            rule = msg.get("ruleId")
            if rule is None and not msg.get("fatal"):
                # `ruleId: null` without `fatal` is ESLint talking about the config, not about the
                # code: an inline `eslint-disable` with no effect because of noInlineConfig. It has
                # no rule to attribute and no line to judge, and counting it would put upstream's
                # disable comments in our findings.
                continue
            findings.append(
                {
                    "file": path,
                    "line": int(msg.get("line") or 0),
                    "rule": rule or "fatal",
                    "message": (msg.get("message") or "").splitlines()[0],
                }
            )
    return findings


def parse_shellcheck(raw):
    findings = []
    payload = json.loads(raw or "[]")
    # `shellcheck -f json1 <files>` prints a bare array; the version that wraps its output in an
    # object (`{"comments": [...]}`) is what a newer shellcheck emits for the same invocation, and
    # reading only one shape would make the gate silently find nothing on the other.
    items = payload.get("comments", []) if isinstance(payload, dict) else payload
    for item in items:
        findings.append(
            {
                "file": item.get("file", ""),
                "line": int(item.get("line") or 0),
                "rule": f"SC{item.get('code')}",
                "message": item.get("message", ""),
            }
        )
    return findings


DART_MACHINE = re.compile(
    r"^(?P<sev>[A-Z]+)\|(?P<kind>[^|]*)\|(?P<code>[^|]*)\|(?P<file>[^|]*)\|"
    r"(?P<line>\d+)\|(?P<col>\d+)\|(?P<len>\d+)\|(?P<msg>.*)$"
)


def parse_dart(raw):
    findings = []
    for line in raw.splitlines():
        m = DART_MACHINE.match(line.strip())
        if not m:
            continue
        findings.append(
            {
                "file": m.group("file"),
                "line": int(m.group("line")),
                "rule": m.group("code").strip() or m.group("kind").strip(),
                "message": m.group("msg").strip(),
            }
        )
    return findings


DETEKT_TEXT = re.compile(
    r"^(?P<file>.+?):(?P<line>\d+):(?P<col>\d+): (?P<msg>.*) \[(?P<rule>[A-Za-z]+)\]$"
)


def parse_detekt(raw):
    findings = []
    for line in raw.splitlines():
        m = DETEKT_TEXT.match(line.strip())
        if not m:
            continue
        findings.append(
            {
                "file": m.group("file"),
                "line": int(m.group("line")),
                "rule": m.group("rule"),
                "message": m.group("msg"),
            }
        )
    return findings


PARSERS = {
    "eslint": parse_eslint,
    "shellcheck": parse_shellcheck,
    "dart": parse_dart,
    "detekt": parse_detekt,
}


def _norm(path):
    return os.path.normpath(os.path.abspath(path)) if path else path


def load_added(path, roots):
    """Read `<path>\\t<ranges>` lines; index each path under every tree root."""
    added = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line:
                continue
            rel, _, spans = line.partition("\t")
            ranges = []
            for span in spans.split(","):
                a, _, b = span.partition("-")
                ranges.append((int(a), int(b or a)))
            added[_norm(rel)] = ranges
            for root in roots:
                added[_norm(os.path.join(root, rel))] = ranges
    return added


def _ranges_of(finding, added, roots):
    """The added-line ranges for this finding's file, or None if the file is out of scope.

    Tools disagree about the path they print: ESLint prints an absolute path,
    shellcheck prints what it was given, detekt one or the other. Trying the
    printed path and then each known root covers all four without a per-tool
    path rule that would drift.
    """
    key = _norm(finding["file"])
    if key in added:
        return added[key]
    for root in roots:
        key = _norm(os.path.join(root, finding["file"]))
        if key in added:
            return added[key]
    return None


def cmd_report(args):
    opts = {"format": None, "added": None, "label": "", "root": [], "rule": []}
    i = 0
    while i < len(args):
        arg = args[i]
        key = arg.lstrip("-")
        if arg in ("--format", "--added", "--label", "--root", "--rule"):
            value = args[i + 1]
            if isinstance(opts[key], list):
                opts[key].append(value)
            else:
                opts[key] = value
            i += 2
        else:
            print(f"unknown argument: {arg}", file=sys.stderr)
            return 2
    if not opts["format"] or opts["format"] not in PARSERS:
        print(f"--format must be one of {sorted(PARSERS)}", file=sys.stderr)
        return 2
    if not opts["added"]:
        print("--added is required", file=sys.stderr)
        return 2

    roots = opts["root"]
    added = load_added(opts["added"], roots)
    wanted = {code.upper() for code in opts["rule"]}
    parsed = PARSERS[opts["format"]](sys.stdin.read())
    # `fatal` is a parse error, not a rule: it means the linter could not read the file at all, so
    # the rule filter must never drop it. Filtering it out is how a gate that cannot run reports
    # zero findings — which is exactly what a missing tsconfig did before this case was written.
    findings = [f for f in parsed if not wanted or f["rule"] == "fatal" or f["rule"].upper() in wanted]

    ours, upstream, out_of_scope = [], [], []
    for finding in findings:
        if finding["rule"] == "fatal":
            # A file the linter could not read was not linted at all, so none of our lines in it
            # were checked. Line 0/1 of a parse error is not a position to attribute by, and
            # calling it "upstream" would be the gate quietly passing over a file it never read.
            ours.append(finding)
            continue
        ranges = _ranges_of(finding, added, roots)
        if ranges is None:
            out_of_scope.append(finding)
        elif any(a <= finding["line"] <= b for a, b in ranges):
            ours.append(finding)
        else:
            upstream.append(finding)

    # A finding in a file no patch touches is a wiring bug on our side — the
    # linter was pointed at our files. Counted as ours, where somebody sees it,
    # instead of dropped.
    ours = out_of_scope + ours
    for finding in upstream:
        print(f"upstream  {_short(finding['file'], roots)}:{finding['line']} {finding['rule']} {finding['message']}")
    for finding in ours:
        print(f"OURS      {_short(finding['file'], roots)}:{finding['line']} {finding['rule']} {finding['message']}")
    print(f"{opts['label']}: {len(ours)} on our lines, {len(upstream)} on upstream lines of the same files")
    return 1 if ours else 0


def _short(path, roots):
    """The path as the reader expects it: relative to the tree the tool ran in."""
    best = path
    for root in roots:
        base = os.path.join(_norm(root), "")
        if path.startswith(base) and len(base) < len(path):
            candidate = path[len(base):]
            if len(candidate) < len(best):
                best = candidate
    return best


def main(argv):
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    command, args = argv[1], argv[2:]
    if command == "added":
        return cmd_added(args)
    if command == "report":
        return cmd_report(args)
    print(f"unknown command: {command}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

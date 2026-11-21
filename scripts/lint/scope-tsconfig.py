#!/usr/bin/env python3
"""Write a tsconfig scoped to the files our patches change.

ESLint's type-aware rules need every linted file to belong to the project they are given, and
upstream's own tsconfig does not include all of them: element-call's `include` covers src/, sdk/,
component/ and playwright/ but not vite.config.ts, which one of our patches edits. Pointing the
linter at that tsconfig makes @typescript-eslint answer "Parsing error: file was not found by the
project" for that file — a red gate for a file we legitimately touch, and no type information for
it either.

So the project handed over is the tree's own tsconfig with `include` replaced by exactly the files
we pass. Everything else — paths, lib, jsx, strictness — stays upstream's, because a type-aware rule
judged against settings we invented would disagree with the compiler that builds the app.

Usage: scope-tsconfig.py <tree tsconfig.json> <files...>
Prints the scoped config on stdout. `files` are relative to the tsconfig's directory, which is how
the gate passes them (`git diff` paths of the patched tree).
"""
import json
import os
import sys


def strip_json_comments(text):
    """tsconfig.json is JSON5-ish: comments and trailing commas are legal in it.

    json.loads rejects both, and every tsconfig in these trees has comments in it — upstream's
    element-call config explains each option inline. A regex on strings would be fragile, so this
    walks the text and drops comment runs outside string literals.
    """
    out = []
    i = 0
    in_string = False
    while i < len(text):
        ch = text[i]
        if in_string:
            out.append(ch)
            if ch == "\\":
                out.append(text[i + 1] if i + 1 < len(text) else "")
                i += 2
                continue
            if ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        if text.startswith("//", i):
            nl = text.find("\n", i)
            i = len(text) if nl == -1 else nl
            continue
        if text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = len(text) if end == -1 else end + 2
            continue
        out.append(ch)
        i += 1
    # Trailing commas before a closing brace or bracket are legal in tsconfig too.
    cleaned = "".join(out)
    return cleaned


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    path = sys.argv[1]
    files = sys.argv[2:]
    with open(path, encoding="utf-8") as fh:
        text = strip_json_comments(fh.read())
    try:
        config = json.loads(text)
    except json.JSONDecodeError as exc:
        print(f"cannot parse {path}: {exc}", file=sys.stderr)
        return 1

    base = os.path.dirname(os.path.abspath(path))
    # Paths are anchored at the tsconfig's own directory, exactly as `include` would be. Relative
    # inputs are resolved against it, not against the caller's cwd: the gate passes `git diff` paths
    # relative to the tree, and it runs from the repository root, so resolving them against the cwd
    # produced `../../lint-patches/src/main.tsx` and TS18003 "No inputs were found".
    config["include"] = [os.path.relpath(os.path.join(base, f), base) for f in files]
    config.pop("exclude", None)
    config["compilerOptions"] = config.get("compilerOptions", {})
    config["compilerOptions"]["noEmit"] = True
    print(json.dumps(config, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

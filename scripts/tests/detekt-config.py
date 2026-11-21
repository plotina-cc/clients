#!/usr/bin/env python3
"""Derive a detekt config that keeps exactly the rules we want and switches everything else off.

detekt's defaults enable ~200 rules. Pointing it at our own files does not help:
the file set is small, the rule set is not, and a report full of upstream-style
noise (MagicNumber, TooGenericExceptionCaught, naming) is how a gate gets
switched off — or turned into "red forever", which is the same decoration the
other way round. So: take detekt's own default config, turn every rule off, turn
the five rules from the card back on.

Usage: detekt-config.py <default-detekt.yml> <output.yml>

Rules switched on (everything else off):

  exceptions.SwallowedException            a catch that drops the exception
  empty-blocks.EmptyCatchBlock             an empty catch block
  coroutines.GlobalCoroutineUsage          GlobalScope outside a top-level object
  coroutines.SuspendFunSwallowedCancellation  a suspend fun losing cancellation
  coroutines.SleepInsteadOfDelay           Thread.sleep in coroutine code

Run as a script, not inline: the guard in this environment blocks -c/-e.
"""
import re
import sys

# Keyed by ruleset, because two rulesets now carry a rule with the same name is
# not a thing here, but a rule renamed to another ruleset would otherwise be
# silently switched on in the wrong block.
KEEP = {
    "exceptions": {"SwallowedException"},
    "empty-blocks": {"EmptyCatchBlock"},
    "coroutines": {
        "GlobalCoroutineUsage",
        "SuspendFunSwallowedCancellation",
        "SleepInsteadOfDelay",
    },
}

# Only these top-level keys hold rules. `build:`, `config:`, `processors:`,
# `console-reports:` and `output-reports:` are settings, and rewriting their
# scalars into `active: false` produces a config detekt rejects as invalid.
RULESETS = set(KEEP) | {"complexity", "naming", "performance", "potential-bugs", "style"}
RULESET_LINE = re.compile(r"^(?P<name>[a-z][a-z0-9-]*):(?:[ \t].*)?$")
RULE_LINE = re.compile(r"^ {2}(?P<name>[A-Za-z][A-Za-z0-9]*):(?:[ \t].*)?$")
PROPERTY_LINE = re.compile(r"^ {4,}\S")


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]

    kept = 0
    out = []
    ruleset = None
    rule = None
    dropping_properties = False
    with open(src, encoding="utf-8") as fh:
        for line in fh:
            stripped = line.rstrip("\n")
            if not stripped.startswith((" ", "\t")):
                m = RULESET_LINE.match(stripped)
                ruleset = m.group("name") if m and m.group("name") in RULESETS else None
                rule = None
                dropping_properties = False
                out.append(stripped)
                continue
            if ruleset is None:
                out.append(stripped)
                continue
            m = RULE_LINE.match(stripped)
            if m:
                rule = m.group("name")
                if rule == "active":
                    # The ruleset's own switch, not a rule: leaving it false would
                    # silence the five rules we just turned on.
                    out.append("  active: true")
                    rule = None
                    dropping_properties = False
                    continue
                on = rule in KEEP.get(ruleset, ())
                kept += on
                out.append(f"  {rule}:")
                out.append(f"    active: {'true' if on else 'false'}")
                dropping_properties = True
                continue
            # Properties of a rule we just rewrote are dropped: they encoded the
            # upstream defaults we did not measure, and half a rule block reads
            # like a hand edit somebody will later "restore".
            if dropping_properties and PROPERTY_LINE.match(stripped):
                continue
            out.append(stripped)

    with open(dst, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out) + "\n")
    print(f"wrote {dst}: {kept} rules on, every other rule off")
    return 0 if kept == sum(len(v) for v in KEEP.values()) else 1


if __name__ == "__main__":
    sys.exit(main())

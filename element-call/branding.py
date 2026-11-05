#!/usr/bin/env python3
"""Replace the Element Call brand with Plotina Call in a built dist.

    branding.py <dist-dir>              # brand in place, idempotent
    branding.py --check <dist-dir>      # exit 1 unless already branded
    branding.py --icons DIR <dist-dir>  # brand from another icon tree (tests)

Runs on the release tarball after inject-noise.py, so it edits the shipped
document shell and the minified bundle: no sources, no rebuild. The rules are
a table of literal patterns, one per occurrence, each with the number of hits
expected in the pinned build. A pattern that matches a different number of
times aborts the run instead of guessing — the counter is the review
mechanism: bumping EC_TAG in pins.env makes every string the brand touches
auditable, not silently rewritten.

Two things are deliberately out of scope. The i18n JSON files under assets/
keep their "Element Call" strings (`header_label` per locale, four in the
German one): the table is JS + index.html only, and rewording translations is
a different change with a different review. The logo's `aria-label` is also
untouched, for the same reason. Both are asserted in tests so a future tag
bump cannot quietly widen the gap.

Quotes are matched as `['"`]` with a backreference: the minifier picks the
style, not us, and `'Element Call'` and `Element Call` are the same string to
this table.

An aborted run may leave the dist partly branded: it writes each file it has
finished before it counts the next one. That is safe because the caller owns
the tree — build.sh brands a scratch extraction and `set -e` stops the build
before anything is packed — but do not point this script at a served directory.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path

UPSTREAM_NAME = "Element Call"
BRAND = "Plotina Call"
TOKEN = "@NAME@"

# Occurrences of the old name that stay upstream's on purpose, over all chunks:
# the `aria-label` of the header logo, which the agreed rule list does not
# cover (the locale JSONs keep their own "Element Call" strings for the same
# reason — rewording translations is a separate change).
KNOWN_LEFTOVERS = 1

# One quote character, captured so the closing quote can be back-referenced:
# the minifier picks `'`, `"` or a template literal, and the rule table must
# not care which.
Q = "(['\"`])"


def _lit(text: str) -> str:
    return re.escape(text)


# The literals are the ones in the built bundle, pinned to EC_TAG: every
# context below was read out of assets/index-FUQuguOr.js and index.html of
# element-call-0.26.1.tar.gz (sha256 in pins.env), not guessed from the
# TypeScript sources — the minifier rewrites those, so the shipped bytes are
# the contract here. One line per rule, with what it is:
#   document_title      let t=`Element Call`;document.title=e?`${t} | ${e}`:t
#   beta_logo_label     the <desc> of the logo, which some AT reads aloud
#   product_name        {productName:…,version:…} in the settings footer
#   close_host_error    "Failed to ask the host to close …", two call sites
#   brand_argument      {brand:…} in the two localised error messages
#   version_log         the F.info(`… v0.26.1`) console line at startup
#   privacy_url         the sign-in footer's Privacy Policy link
#   cookie_policy_url   the same footer's Cookie Policy link
#   docs_url            the SFU-connectivity error's documentation link
#   theme_default       the ?theme= parse site, `theme:n.getParam(`theme`)`,
#                       given its missing-value fallback: `??`dark``
JS_SUBS: tuple["Sub", ...] = ()
HTML_SUBS: tuple["Sub", ...] = ()

# target name in dist -> candidate sources under branding/icons, first hit wins
ICON_FILES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("favicon.png", ("png/green-48.png",)),
    ("plotina-512.png", ("png/green-512.png",)),
    ("plotina-icon.svg", ("plotina-icon.svg", "plotina-green.svg")),
)


class BrandingError(Exception):
    """A rule did not match the pinned build, or an input is missing."""


@dataclass(frozen=True)
class Sub:
    """One literal and how many times the pinned build carries it."""

    name: str
    upstream: str  # the exact text upstream writes, e.g. "Element Call (Beta)"
    branded: str  # the exact text we replace it with
    old: str  # regex source matching the upstream form, with its context
    new: str  # regex source matching the branded form
    replacement: object  # str (re.sub template) or callable(match) -> str
    expected: int

    @property
    def renames(self) -> bool:
        """True when the literal holds the product name being rebranded."""
        return UPSTREAM_NAME in self.upstream

    @property
    def name_tokens(self) -> int:
        return self.upstream.count(UPSTREAM_NAME)

    @property
    def old_re(self) -> re.Pattern[str]:
        return re.compile(self.old)

    @property
    def new_re(self) -> re.Pattern[str]:
        return re.compile(self.new)

    def swap(self, text: str) -> tuple[str, int]:
        """Replace every old hit; returns the new text and the hit count."""
        if callable(self.replacement):
            return self.old_re.subn(self.replacement, text)
        return self.old_re.subn(str(self.replacement), text)

    def hits(self, text: str, branded: bool = False) -> int:
        return len((self.new_re if branded else self.old_re).findall(text))


def renamed(
    name: str,
    pattern: str,
    expected: int,
    *,
    upstream: str = UPSTREAM_NAME,
    branded: str = BRAND,
) -> Sub:
    """A rule whose match is one literal holding the product name.

    The swap operates on the matched text only, so the context the pattern
    captured — the "(Beta)" suffix of the logo label, the " v0.26.1" of the
    console line, the quotes around each — is rewritten exactly as the table
    says and nothing outside the match moves.
    """
    if pattern.count(TOKEN) != 1:
        raise ValueError(f"{name}: the pattern must contain exactly one {TOKEN}")

    def swap(match: re.Match[str]) -> str:
        return match.group(0).replace(upstream, branded)

    return Sub(
        name,
        upstream,
        branded,
        pattern.replace(TOKEN, _lit(upstream)),
        pattern.replace(TOKEN, _lit(branded)),
        swap,
        expected,
    )


def replaced(
    name: str,
    upstream: str,
    branded: str,
    expected: int,
    *,
    pattern: str = "",
    template: str | None = None,
) -> Sub:
    """A rule that swaps a whole literal (a URL, an icon path) for ours.

    `pattern` is the regex of the upstream form; it defaults to the literal
    itself and may add a fragment or an attribute prefix to consume. `template`
    is the re.sub replacement when the pattern carries groups that have to
    survive the swap.
    """
    return Sub(
        name,
        upstream,
        branded,
        pattern or _lit(upstream),
        _lit(branded),
        branded if template is None else template,
        expected,
    )


JS_SUBS = (
    # let t="Element Call";document.title=e?`${t} | ${e}`:t
    renamed("document_title", r"let t=" + Q + TOKEN + r"\1;document\.title=", 1),
    # the beta logo's <desc>: upstream's label becomes the plain product name
    renamed("beta_logo_label", Q + TOKEN + r"\1", 1, upstream=f"{UPSTREAM_NAME} (Beta)"),
    renamed("product_name", r"productName:" + Q + TOKEN + r"\1", 1),
    renamed("close_host_error", Q + "Failed to ask the host to close " + TOKEN + r"\1", 2),
    renamed("brand_argument", r"brand:" + Q + TOKEN + r"\1", 2),
    # the version in the console line is the build's own: only the name moves
    renamed("version_log", r"info\(" + Q + TOKEN + r" v?\d[\w.+-]*\1", 1),
    replaced("privacy_url", "https://element.io/privacy", "https://plotina.cc", 1),
    replaced("cookie_policy_url", "https://element.io/cookie-policy", "https://plotina.cc", 1),
    replaced(
        # the fragment goes with it: an anchor of a page that no longer exists
        # is worse than no anchor at all
        "docs_url",
        "https://docs.element.io/latest/element-server-suite-pro/configuring-components/"
        "configuring-matrix-rtc/",
        "https://github.com/plotina-cc/clients",
        1,
        pattern=r"https://docs\.element\.io/latest/element-server-suite-pro/"
        r"configuring-components/configuring-matrix-rtc/[A-Za-z0-9_.#-]*",
    ),
    # Plotina Call opens dark. Upstream reads the only theme input, `?theme=`,
    # bare — `theme:n.getParam(`theme`)` yields null when the parameter is
    # absent, and the bundle carries no prefers-color-scheme fallback at all:
    # what a null theme looks like is then whichever default some component
    # happens to pick, one upstream `?:` flip away from light. This rule pins
    # the answer at the parse site — `??`dark``, so every consumer of
    # UrlParams.theme sees "dark" with no parameter, while an explicit
    # ?theme=light still wins (`??` only fills the missing value).
    # The (?!??) lookahead is the idempotency guard: a branded bundle no
    # longer matches, so a second run is a no-op instead of stacking
    # fallbacks — and the expected count is the usual abort signal if
    # upstream ever grows a second parse site.
    replaced(
        "theme_default",
        "theme:n.getParam(`theme`)",
        "theme:n.getParam(`theme`)??`dark`",
        1,
        pattern=r"theme:n\.getParam\(" + Q + r"theme\1\)(?!\?\?)",
        template=r"theme:n.getParam(\g<1>theme\g<1>)??`dark`",
    ),
)

HTML_SUBS = (
    renamed("title", r"<title>" + TOKEN + r"</title>", 1),
    renamed("og_title", r'(<meta property="og:title" content=")' + TOKEN + '(")', 1),
    renamed("twitter_title", r'(<meta name="twitter:title" content=")' + TOKEN + '(")', 1),
    renamed("social_description", r"content=\"You're invited to join a call on " + TOKEN + '"', 2),
    replaced(
        "og_image",
        "favicon.png",
        "/plotina-512.png",
        1,
        pattern=r'(<meta property="og:image" content=")' + _lit("favicon.png") + '(")',
        template=r"\g<1>/plotina-512.png\g<2>",
    ),
    replaced(
        "twitter_image",
        "favicon.png",
        "/plotina-512.png",
        1,
        pattern=r'(<meta name="twitter:image" content=")' + _lit("favicon.png") + '(")',
        template=r"\g<1>/plotina-512.png\g<2>",
    ),
    replaced(
        # upstream points the icon link at favicon.png with an svg mime type;
        # only the href is ours to change
        "icon_link",
        "favicon.png",
        "/plotina-icon.svg",
        1,
        pattern=r'(<link rel="icon"[^>]*?href=")' + _lit("favicon.png") + '(")',
        template=r"\g<1>/plotina-icon.svg\g<2>",
    ),
)


@dataclass
class Report:
    """What a run did, for the build log and for the tests."""

    dist: Path
    counts: dict[str, int] = field(default_factory=dict)
    files: list[str] = field(default_factory=list)
    icons: list[str] = field(default_factory=list)
    ok: bool = True

    def summary(self) -> str:
        rules = " ".join(f"{name}={n}" for name, n in sorted(self.counts.items()))
        return f"{self.dist}: {rules}"


def brand_html(html: str, *, strict: bool = True) -> tuple[str, dict[str, int]]:
    """Brand the document shell. See brand_text."""
    return brand_text(html, HTML_SUBS, strict=strict)


def brand_js(js: str, *, strict: bool = True) -> tuple[str, dict[str, int]]:
    """Brand one JS chunk. See brand_text."""
    return brand_text(js, JS_SUBS, strict=strict)


def brand_text(
    text: str, subs: tuple[Sub, ...], *, strict: bool = True
) -> tuple[str, dict[str, int]]:
    """Apply every rule to one string and check the counters.

    strict means "this text is the whole input": a rule must find exactly
    `expected` upstream hits, or — for an already branded text — none plus at
    least `expected` branded hits. Counts stay equal in both cases so a second
    run reports what this dist carries rather than zero, which is what makes
    the build log comparable across rebuilds.

    Non-strict is the per-chunk mode used by apply_dist, where the totals are
    checked over all chunks at once: a Vite chunk that holds none of the
    literals is normal, not an error.
    """
    counts: dict[str, int] = {}
    before = text.count(UPSTREAM_NAME)
    contributed = 0
    for sub in subs:
        old_hits = sub.hits(text)
        if old_hits == 0:
            if strict and sub.hits(text, branded=True) < sub.expected:
                raise BrandingError(
                    f"{sub.name}: no {UPSTREAM_NAME!r} and no {BRAND!r} "
                    f"(expected {sub.expected}) — upstream changed"
                )
            counts[sub.name] = sub.expected if strict else 0
            continue
        if strict and old_hits != sub.expected:
            raise BrandingError(
                f"{sub.name}: found {old_hits} occurrences, expected {sub.expected} — "
                f"upstream changed, review the rule table before branding"
            )
        text, n = sub.swap(text)
        counts[sub.name] = (counts.get(sub.name, 0) + n) if not strict else n
        # Only the rules that actually found something owe the name-token
        # identity: an already branded text is a no-op for them, not a loss.
        contributed += n * sub.name_tokens

    if strict:
        lost = before - text.count(UPSTREAM_NAME)
        if lost != contributed:
            raise BrandingError(
                f"{UPSTREAM_NAME!r} occurrences dropped by {lost}, rules account for "
                f"{contributed} — a rule matched outside its literal"
            )
    return text, counts


def verify_text(
    text: str, subs: tuple[Sub, ...], label: str, *, check_branded: bool = True
) -> list[str]:
    """--check for one string: no upstream hits left, branded hits present.

    check_branded is off for a single chunk: which chunk holds which literal is
    Vite's choice, so only the whole bundle can be counted.
    """
    errors = []
    for sub in subs:
        old_hits = sub.hits(text)
        if old_hits:
            errors.append(f"{label}: {sub.name} still matches {old_hits} time(s)")
        if not check_branded:
            continue
        branded = sub.hits(text, branded=True)
        if branded < sub.expected:
            errors.append(
                f"{label}: {sub.name} branded form found {branded}x, expected "
                f">= {sub.expected}"
            )
    return errors


def js_chunks(dist: Path) -> list[Path]:
    """The built scripts under assets/ — no .map, nothing outside the bundle."""
    return sorted((dist / "assets").rglob("*.js"))


def apply_dist(dist: Path, icons: Path) -> Report:
    """Brand index.html plus every chunk under assets/, and carry the icons in."""
    index = dist / "index.html"
    if not index.is_file():
        raise BrandingError(f"{index} is not a file: not an Element Call dist")

    report = Report(dist=dist)

    html, counts = brand_html(index.read_text(encoding="utf-8"))
    index.write_text(html, encoding="utf-8")
    report.counts.update(counts)

    # The counters are checked over all chunks together: Vite may put any of
    # the literals in any of them, and a per-file count would be luck.
    totals: dict[str, int] = {}
    lost = 0
    for path in js_chunks(dist):
        js = path.read_text(encoding="utf-8")
        before = js.count(UPSTREAM_NAME)
        branded, counts = brand_js(js, strict=False)
        if branded != js:
            path.write_text(branded, encoding="utf-8")
            report.files.append(path.name)
        for name, n in counts.items():
            totals[name] = totals.get(name, 0) + n
        lost += before - branded.count(UPSTREAM_NAME)

    all_js = "\n".join(p.read_text(encoding="utf-8") for p in js_chunks(dist))
    for sub in JS_SUBS:
        got = totals.get(sub.name, 0)
        if got == 0:
            # Nothing was replaced here: either this dist was branded already
            # (the branded form proves it) or a rule silently stopped matching.
            branded_hits = len(sub.new_re.findall(all_js))
            if branded_hits < sub.expected:
                raise BrandingError(
                    f"{sub.name}: no match and only {branded_hits} branded form(s), "
                    f"expected {sub.expected} — upstream changed, review the rule table"
                )
        elif got != sub.expected:
            raise BrandingError(
                f"{sub.name}: {got} replacements across the bundle, expected "
                f"{sub.expected} — upstream changed, review the rule table before branding"
            )
        if sub.old_re.search(all_js):
            raise BrandingError(f"{sub.name}: {sub.upstream!r} survived in the bundle")
        # The log reports what the dist carries, so it reads the same after a
        # rebuild of an already branded tree.
        report.counts[sub.name] = sub.expected

    if lost != sum(totals.get(s.name, 0) * s.name_tokens for s in JS_SUBS):
        raise BrandingError(
            f"bundle lost {lost} {UPSTREAM_NAME!r} occurrences, rules account for "
            f"{sum(totals.get(s.name, 0) * s.name_tokens for s in JS_SUBS)} — "
            "a rule matched outside its literal"
        )
    # Exactly one occurrence stays upstream's: the logo's `aria-label`, which is
    # not in the agreed rule list. Any other count means the table and the build
    # have diverged.
    leftover = all_js.count(UPSTREAM_NAME)
    if leftover != KNOWN_LEFTOVERS:
        positions = [m.start() for m in re.finditer(re.escape(UPSTREAM_NAME), all_js)]
        raise BrandingError(
            f"{len(positions)} unbranded {UPSTREAM_NAME!r} occurrences left in the "
            f"bundle, expected {KNOWN_LEFTOVERS} (the logo aria-label) — offsets {positions}"
        )

    report.icons = install_icons(dist, icons)
    return report


def install_icons(dist: Path, icons: Path) -> list[str]:
    """Copy the Plotina marks in and stamp them 0644 like build.sh does."""
    done = []
    for target, sources in ICON_FILES:
        source = next((icons / s for s in sources if (icons / s).is_file()), None)
        if source is None:
            raise BrandingError(f"missing brand icon: {icons / sources[0]}")
        shutil.copyfile(source, dist / target)
        (dist / target).chmod(0o644)
        done.append(target)
    return done


def check_dist(dist: Path, icons: Path) -> list[str]:
    """Every assertion apply_dist made, re-derivable from the dist alone."""
    index = dist / "index.html"
    if not index.is_file():
        return [f"{index} is not a file: not an Element Call dist"]

    errors = verify_text(index.read_text(encoding="utf-8"), HTML_SUBS, "index.html")
    chunks = js_chunks(dist)
    if not chunks:
        return errors + [f"no *.js under {dist / 'assets'}"]
    for path in chunks:
        # A chunk may legitimately hold none of the literals; only the fact
        # that it holds none of the *upstream* names is per-file.
        errors += verify_text(path.read_text(encoding="utf-8"), JS_SUBS, path.name, check_branded=False)

    all_js = "\n".join(p.read_text(encoding="utf-8") for p in chunks)
    for sub in JS_SUBS:
        branded = sum(len(sub.new_re.findall(p.read_text(encoding="utf-8"))) for p in chunks)
        if branded < sub.expected:
            errors.append(
                f"bundle: {sub.name} branded form found {branded}x, expected "
                f">= {sub.expected}"
            )
    if all_js.count(UPSTREAM_NAME) != KNOWN_LEFTOVERS:
        errors.append(
            f"bundle: {all_js.count(UPSTREAM_NAME)} unbranded {UPSTREAM_NAME!r} "
            f"occurrences, expected {KNOWN_LEFTOVERS} (the logo aria-label)"
        )

    for target, sources in ICON_FILES:
        dst = dist / target
        source = next((icons / s for s in sources if (icons / s).is_file()), None)
        if source is None:
            errors.append(f"missing brand icon: {icons / sources[0]}")
            continue
        if not dst.is_file():
            errors.append(f"{dst} is missing")
        elif _sha(dst) != _sha(source):
            errors.append(f"{dst} differs from {source}")
    return errors


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description="Brand a built Element Call dist as Plotina Call.",
        epilog="idempotent: a second run reports the same counters and changes nothing",
    )
    ap.add_argument("dist", help="the extracted dist directory (holds index.html)")
    ap.add_argument("--check", action="store_true", help="verify instead of writing")
    ap.add_argument(
        "--icons",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "branding" / "icons",
        help="icon tree, default: <repo>/branding/icons",
    )
    args = ap.parse_args(argv[1:])

    dist = Path(args.dist)
    if not dist.is_dir():
        print(f"error: {dist} is not a directory", file=sys.stderr)
        return 2
    if not args.icons.is_dir():
        print(f"error: {args.icons} is not a directory", file=sys.stderr)
        return 2

    try:
        if args.check:
            errors = check_dist(dist, args.icons)
            if errors:
                for line in errors:
                    print(f"error: {line}", file=sys.stderr)
                return 1
            print(f"ok: {dist} is branded as {BRAND}")
            return 0
        report = apply_dist(dist, args.icons)
    except BrandingError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(report.summary())
    print(f"branded: {dist} as {BRAND} ({len(report.files)} chunk(s), icons: {' '.join(report.icons)})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

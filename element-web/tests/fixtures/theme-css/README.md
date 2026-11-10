Fixtures for `tests/test_theme_custom_css_vars.py`.

Both trees are a trimmed slice of the **shipped** element-web v1.12.32 build
(bundle `7fef2be0ae8530458db3`), not hand-written CSS: every selector and
declaration in the sheets was copied out of the generated
`theme-{light,dark}-custom.css`, and every definition in `bundle.css` was copied
verbatim out of the build's own stylesheets. Only the rules that reference the
legacy custom properties are kept (two per property), which is why the sheets
are ~6 KB instead of ~530 KB.

```
before/bundles/<hash>/      the defect as upstream generates it
  bundle.css                Compound/space/font properties, verbatim
  theme-light-custom.css    19 legacy properties used bare, none defined
  theme-dark-custom.css

after/bundles/<hash>/       the same tree after the overlay fix
  bundle.css                unchanged
  theme-light-custom.css    the 19 resolved — 18 defined in an injected :root
  theme-dark-custom.css     block (values inherited from Compound tokens),
                            --timeline-text-color's use rewritten to
                            var(--cpd-color-text-primary)
```

The 19 names, measured against the shipped tree: every one is used without a
fallback in **both** sheets and defined by no stylesheet in the webapp —
19 × 2 = the 38 undefined properties from the original report. The list lives
in `SHIPPED_LEGACY_VARS` and is used only as explicit test cases; the artifact
check never consults it, so a new undefined property fails on its own.

Regenerate (needs a checkout of the shipped webapp, e.g. the `element-web`
image's `/app`): the builder is not committed — it was a one-off script over
`/home/hermes/sentry-build/web/element-v1.12.32`. If the upstream shape changes,
re-derive the list from the new artifact and update both the fixture and
`SHIPPED_LEGACY_VARS`, keeping `before` red and `after` green.
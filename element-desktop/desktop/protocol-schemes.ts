/*
Copyright 2026 Plotina <thebob3r@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only

PLOTINA-SHELL-PATCH: copied into apps/desktop/src by scripts/build.sh and the
CI "Apply Plotina desktop sources" step (same pattern as icon.ts/updater.ts).

Upstream's ProtocolHandler registers exactly two schemes: `electron_protocol`
(= variant protocols[0], io.element.desktop) and the legacy `element`. Our
variant (element-desktop/build.plotina.json) advertises three, including
cc.plotina.element, and electron-builder only applies its `protocols` config
to macOS bundles and Linux .desktop files — on Windows nothing registers a
scheme but this handler. The result was a scheme the build advertises and no
component claims: cc.plotina.element:// links went to the browser, and the
release QA recorded `CHECK|protocol:declared|NOT-REGISTERED`.

So the scheme list is derived from the variant at build time
(electron-builder.ts writes electron_protocols, build-config.ts reads it) and
every scheme in it is registered and accepted for deeplinks here. Keep the
logic in this file: it is the one part of the shell patch that is unit-tested
(desktop/tests/protocol-schemes.test.mjs) instead of only grep-asserted.
*/

/** The scheme every Element-based client has always answered to. */
export const LEGACY_PROTOCOL = "element";

/**
 * Normalises a scheme name ("element", "Element:", " cc.plotina.element ").
 * Windows stores scheme keys case-insensitively and Electron's
 * setAsDefaultProtocolClient rejects anything that is not a bare scheme.
 */
export function normaliseScheme(scheme: string): string {
    return String(scheme ?? "")
        .trim()
        .replace(/:$/, "")
        .toLowerCase();
}

/**
 * The full set of schemes this install answers to: the primary protocol, the
 * legacy one, then everything else the variant declares. Order is stable and
 * duplicates (element is both legacy and declared) collapse.
 */
export function protocolSchemeList(primary: string, declared: readonly string[] = []): string[] {
    const schemes: string[] = [];
    for (const candidate of [primary, LEGACY_PROTOCOL, ...declared]) {
        const scheme = normaliseScheme(candidate);
        if (scheme && !schemes.includes(scheme)) schemes.push(scheme);
    }
    return schemes;
}

/** True for a command-line argument that is a deeplink of one of our schemes. */
export function isSchemeUrl(arg: string, schemes: readonly string[]): boolean {
    if (typeof arg !== "string") return false;
    // `${scheme}:/` covers both `scheme://host` and the single-slash form.
    return schemes.some((scheme) => arg.toLowerCase().startsWith(`${scheme}:/`));
}

/** True when a URL's protocol (with or without the colon) is one of ours. */
export function isSchemeProtocol(protocol: string, schemes: readonly string[]): boolean {
    return schemes.includes(normaliseScheme(protocol));
}

/**
 * Claims every scheme for this executable. `args` are the launch arguments
 * Windows has to append when the OS opens a link (getArgsForProtocolRegistration
 * in args.ts strips the ones that must not be replayed).
 */
export function registerProtocolSchemes(
    app: { setAsDefaultProtocolClient: (scheme: string, execPath?: string, args?: string[]) => boolean },
    schemes: readonly string[],
    execPath: string,
    args: string[],
): void {
    for (const scheme of schemes) {
        app.setAsDefaultProtocolClient(scheme, execPath, args);
    }
}

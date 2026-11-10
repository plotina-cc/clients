/*
Copyright 2026 Plotina <thebob3r@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only

PLOTINA-SHELL-PATCH: copied into apps/desktop/src by scripts/build.sh and the
CI "Apply Plotina desktop sources" step (same pattern as icon.ts/updater.ts).

Upstream's ProtocolHandler registers protocols[0] plus the legacy `element`
scheme. Our variant (element-desktop/build.plotina.json) declares exactly one
scheme — io.element.desktop, the SSO callback MAS sends back to — and
electron-builder only applies its `protocols` config to macOS bundles and Linux
.desktop files, so on Windows the only thing that registers it is this handler.
The legacy `element` and the old cc.plotina.element scheme are deliberately
gone: they dragged the word Element into the Windows registry and into the
.desktop file. Uninstall still cleans up their keys on machines that have them
(build/installer.nsh) — that is not a reason to keep registering them.

So the scheme list is derived from the variant at build time
(electron-builder.ts writes electron_protocols, build-config.ts reads it) and
every scheme in it is registered and accepted for deeplinks here. Keep the
logic in this file: it is the one part of the shell patch that is unit-tested
(desktop/tests/protocol-schemes.test.mjs) instead of only grep-asserted.
*/

/**
 * Normalises a scheme name ("io.element.desktop", "IO.Element.Desktop:").
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
 * The full set of schemes this install answers to: the primary protocol, then
 * everything else the variant declares. Nothing is added behind the variant's
 * back — a scheme it does not declare is not claimed. Order is stable and
 * duplicates collapse.
 */
export function protocolSchemeList(primary: string, declared: readonly string[] = []): string[] {
    const schemes: string[] = [];
    for (const candidate of [primary, ...declared]) {
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

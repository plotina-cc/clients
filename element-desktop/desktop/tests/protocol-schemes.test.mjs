// Regression tests for the protocol-scheme claim the shell patch wires in
// (desktop/patch-shell.py + desktop/protocol-schemes.ts).
//
// What this pins: the build registers exactly one URL scheme, io.element.desktop
// — the SSO callback MAS pins in redirect_uris for the "Plotina Desktop"
// client, so it cannot change. The legacy `element` scheme (which upstream's
// ProtocolHandler adds by itself) and the old cc.plotina.element scheme are
// removed on purpose: they put the word Element into the Windows registry and
// into the .desktop file. So neither is registered any more, and a deeplink
// arriving under either name is rejected.
//
// electron-builder applies its own `protocols` config to macOS bundles and
// Linux .desktop files only, which is why the shell has to do the registration
// on Windows at all.
//
//   node --test element-desktop/desktop/tests/protocol-schemes.test.mjs
//
// Same trick as update-feed.test.mjs: the module is imported straight from its
// .ts source via Node >= 22 type-stripping (it has no non-builtin imports).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    isSchemeProtocol,
    isSchemeUrl,
    normaliseScheme,
    protocolSchemeList,
    registerProtocolSchemes,
} from "../protocol-schemes.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VARIANT = JSON.parse(fs.readFileSync(path.join(HERE, "..", "..", "build.plotina.json"), "utf8"));
const DECLARED = VARIANT.protocols;

/** Schemes dropped from the build; never registered, never accepted. */
const RETIRED = ["element", "cc.plotina.element"];

/** Records what the shell would hand to Electron. */
function stubApp() {
    const calls = [];
    return {
        calls,
        setAsDefaultProtocolClient: (scheme, execPath, args) => {
            calls.push({ scheme, execPath, args });
            return true;
        },
    };
}

test("the variant declares only the SSO callback scheme", () => {
    // io.element.desktop is pinned by MAS redirect_uris; anything else in here
    // reappears in the Windows registry, the Linux .desktop file and the
    // browser's handler list.
    assert.deepEqual(DECLARED, ["io.element.desktop"]);
});

test("the retired schemes are gone from the variant", () => {
    for (const retired of RETIRED) {
        assert.equal(DECLARED.includes(retired), false, `${retired} is back in build.plotina.json`);
    }
});

test("the scheme list is exactly what the variant declares", () => {
    const schemes = protocolSchemeList(DECLARED[0], DECLARED);
    assert.deepEqual(schemes, ["io.element.desktop"]);
    // No implicit legacy addition: with nothing declared, nothing is claimed.
    assert.deepEqual(protocolSchemeList("io.element.desktop", []), ["io.element.desktop"]);
    assert.deepEqual(protocolSchemeList("", []), []);
});

test("scheme list is de-duplicated and normalised", () => {
    assert.deepEqual(protocolSchemeList("io.element.desktop", ["IO.Element.Desktop", " "]), [
        "io.element.desktop",
    ]);
    assert.deepEqual(protocolSchemeList("IO.Element.Desktop:", ["io.element.desktop"]), [
        "io.element.desktop",
    ]);
    assert.equal(normaliseScheme("  cc.plotina.element:  "), "cc.plotina.element");
});

test("registration claims only the declared scheme for the running executable", () => {
    const app = stubApp();
    const schemes = protocolSchemeList(DECLARED[0], DECLARED);
    registerProtocolSchemes(app, schemes, "/opt/Plotina/Plotina-Desktop.exe", ["--no-update"]);

    assert.deepEqual(app.calls.map((c) => c.scheme), ["io.element.desktop"]);
    for (const call of app.calls) {
        assert.equal(call.execPath, "/opt/Plotina/Plotina-Desktop.exe");
        assert.deepEqual(call.args, ["--no-update"]);
    }
});

test("the declared SSO deeplink is accepted", () => {
    const schemes = protocolSchemeList(DECLARED[0], DECLARED);
    const url = "io.element.desktop:/vector/webapp/?no_universal_links=true";
    assert.ok(isSchemeUrl(url, schemes), "the SSO callback is not recognised");
    assert.ok(isSchemeUrl("io.element.desktop://vector/webapp/#/room/!x:plotina.cc", schemes));
    assert.ok(isSchemeProtocol("io.element.desktop:", schemes));
    assert.ok(isSchemeProtocol("io.element.desktop", schemes));
    assert.ok(isSchemeUrl("IO.Element.Desktop:/vector/webapp/", schemes), "Windows may hand over another case");
});

test("the retired schemes are not accepted as our deeplinks", () => {
    const schemes = protocolSchemeList(DECLARED[0], DECLARED);
    for (const retired of RETIRED) {
        assert.equal(isSchemeUrl(`${retired}://vector/webapp/`, schemes), false, `${retired}:// still accepted`);
        assert.equal(
            isSchemeUrl(`${retired}:/vector/webapp/?no_universal_links=true`, schemes),
            false,
            `${retired}:/ still accepted`,
        );
        assert.equal(isSchemeProtocol(`${retired}:`, schemes), false, `${retired}: still accepted`);
        assert.equal(isSchemeProtocol(retired, schemes), false, `${retired} still accepted`);
    }
    // Capitalised forms must not sneak through either.
    assert.equal(isSchemeUrl("ELEMENT://vector/webapp/", schemes), false);
    assert.equal(isSchemeUrl("CC.Plotina.Element://vector/webapp/", schemes), false);
});

test("unrelated schemes are still rejected", () => {
    const schemes = protocolSchemeList(DECLARED[0], DECLARED);
    for (const foreign of ["https://plotina.cc", "matrix:u/bob:plotina.cc", "elementx://x", "vector://vector/webapp/"]) {
        assert.equal(isSchemeUrl(foreign, schemes), false, `${foreign} must not be treated as our deeplink`);
    }
    assert.equal(isSchemeProtocol("https:", schemes), false);
    // matrix: is deliberately NOT claimed: taking over every matrix: link from
    // other installed clients is a product decision we did not take.
    assert.equal(schemes.includes("matrix"), false);
});

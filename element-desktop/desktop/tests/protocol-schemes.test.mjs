// Regression tests for the protocol-scheme claim the shell patch wires in
// (desktop/patch-shell.py + desktop/protocol-schemes.ts).
//
// The bug this pins: build.plotina.json advertises
// protocols: [io.element.desktop, element, cc.plotina.element], but upstream's
// ProtocolHandler registered only protocols[0] and the legacy `element` scheme,
// and electron-builder applies its own `protocols` config to macOS bundles and
// Linux .desktop files only. On Windows nothing claimed cc.plotina.element, so
// cc.plotina.element:// links opened the browser and the release QA recorded
// `CHECK|protocol:declared|NOT-REGISTERED`.
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
    LEGACY_PROTOCOL,
    isSchemeProtocol,
    isSchemeUrl,
    normaliseScheme,
    protocolSchemeList,
    registerProtocolSchemes,
} from "../protocol-schemes.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VARIANT = JSON.parse(fs.readFileSync(path.join(HERE, "..", "..", "build.plotina.json"), "utf8"));
const DECLARED = VARIANT.protocols;

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

test("the variant really declares the scheme this card is about", () => {
    // If the scheme is ever dropped from the variant deliberately, delete the
    // cc.plotina.element expectations below instead of letting them rot.
    assert.deepEqual(DECLARED, ["io.element.desktop", "element", "cc.plotina.element"]);
});

test("every declared scheme is claimed, not just protocols[0]", () => {
    const schemes = protocolSchemeList(DECLARED[0], DECLARED);
    for (const declared of DECLARED) {
        assert.ok(schemes.includes(declared), `${declared} is declared but missing from the scheme list`);
    }
    assert.ok(schemes.includes(LEGACY_PROTOCOL));
    assert.deepEqual(schemes, ["io.element.desktop", "element", "cc.plotina.element"]);
});

test("scheme list is de-duplicated and normalised", () => {
    assert.deepEqual(protocolSchemeList("io.element.desktop", ["IO.Element.Desktop", "element", " "]), [
        "io.element.desktop",
        "element",
    ]);
    assert.deepEqual(protocolSchemeList("", []), ["element"], "the legacy scheme is always claimed");
    assert.equal(normaliseScheme("  cc.plotina.element:  "), "cc.plotina.element");
});

test("registration claims each scheme for the running executable", () => {
    const app = stubApp();
    const schemes = protocolSchemeList(DECLARED[0], DECLARED);
    registerProtocolSchemes(app, schemes, "/opt/Plotina/Plotina-Desktop.exe", ["--no-update"]);

    assert.deepEqual(
        app.calls.map((c) => c.scheme),
        ["io.element.desktop", "element", "cc.plotina.element"],
    );
    for (const call of app.calls) {
        assert.equal(call.execPath, "/opt/Plotina/Plotina-Desktop.exe");
        assert.deepEqual(call.args, ["--no-update"]);
    }
});

test("deeplinks are accepted for every declared scheme", () => {
    const schemes = protocolSchemeList(DECLARED[0], DECLARED);
    for (const scheme of DECLARED) {
        assert.ok(isSchemeUrl(`${scheme}://vector/webapp/#/room/!x:plotina.cc`, schemes), `${scheme} deeplink not recognised`);
        assert.ok(isSchemeUrl(`${scheme}:/vector/webapp/?ssoid=1`, schemes), `${scheme} single-slash form not recognised`);
        assert.ok(isSchemeProtocol(`${scheme}:`, schemes), `${scheme} protocol not accepted`);
        assert.ok(isSchemeProtocol(scheme, schemes), `${scheme} protocol without colon not accepted`);
    }
    assert.ok(isSchemeUrl("CC.Plotina.Element://vector/webapp/", schemes), "Windows may hand over a different case");
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

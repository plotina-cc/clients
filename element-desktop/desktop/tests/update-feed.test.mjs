// Feed-URL tests for the ipc.ts patch (desktop/patch-shell.py wires
// getUpdateFeedUrl here). The webapp's Settings -> "Check for updates" button
// is rendered iff canSelfUpdate() = Boolean(await ipc("getUpdateFeedUrl")),
// and upstream answers with Electron's Squirrel-only autoUpdater.getFeedURL(),
// which throws on Linux — leaving the IPC unanswered and the button hidden
// even though our AppImage updater works.
//
//   node --test element-desktop/desktop/tests/update-feed.test.mjs
//
// Same trick as linux-updater.test.mjs: "electron" is mapped to the stub and
// ../updater.ts is imported directly via Node >= 22 type-stripping.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "electron") {
            return { url: import.meta.resolve("./electron-stub.mjs"), shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});

const updater = await import("../updater.ts");
const FEED = updater.PLOTINA_RELEASES_FEED;

test("feed URL points at the repo CI publishes to", () => {
    assert.equal(FEED, "https://github.com/plotina-cc/clients/releases");
});

test("plotinaUpdateFeed mirrors detectUpdateMode", () => {
    assert.match(updater.plotinaUpdateFeed("linux", { APPIMAGE: "/x/Plotina.AppImage" }), /^https/);
    assert.equal(updater.plotinaUpdateFeed("linux", { APPIMAGE: FEED }), FEED);
    assert.equal(updater.plotinaUpdateFeed("linux", {}), "", "deb installs must not advertise a feed");
    assert.equal(updater.plotinaUpdateFeed("win32", {}), FEED);
    assert.equal(updater.plotinaUpdateFeed("darwin", { APPIMAGE: "nope" }), "");
    assert.equal(updater.plotinaUpdateFeed("freebsd", {}), "");
});

test("getUpdateFeedUrl answers from the real env/platform (no throw)", () => {
    if (process.platform === "linux") {
        const saved = process.env.APPIMAGE;
        try {
            process.env.APPIMAGE = "/tmp/Plotina-Desktop.AppImage";
            assert.equal(updater.getUpdateFeedUrl(), FEED, "AppImage run must enable the button");
            delete process.env.APPIMAGE;
            assert.equal(updater.getUpdateFeedUrl(), "", "deb run must keep it hidden");
        } finally {
            if (saved === undefined) delete process.env.APPIMAGE;
            else process.env.APPIMAGE = saved;
        }
    } else if (process.platform === "win32") {
        assert.equal(updater.getUpdateFeedUrl(), FEED);
    } else {
        assert.equal(updater.getUpdateFeedUrl(), "");
    }
});

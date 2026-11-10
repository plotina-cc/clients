#!/usr/bin/env python3
"""Apply Plotina's shell patches to an element-web apps/desktop tree.

    desktop/patch-shell.py [path/to/apps/desktop/src]

Every edit is pinned with unique-context asserts so an upstream drift fails the
build loudly instead of silently shipping the old behaviour:

1. electron-main.ts — the main window's `icon` option goes through
   getMainWindowIcon() (desktop/icon.ts): Chromium cannot fit a 256x256 icon
   into one _NET_WM_ICON XChangeProperty request, so the X11 window icon is
   capped at 128x128 and the property actually gets data.

2. ipc.ts — `getUpdateFeedUrl` answers with our updater's GitHub-releases feed
   instead of Electron's Squirrel-only autoUpdater.getFeedURL(), which throws
   on Linux. The webapp hides Settings -> Help & About's "Check for updates"
   whenever that IPC has no answer (canSelfUpdate() never resolves), even
   though our AppImage/NSIS updater works fine.

3. ipc.ts — `getUpdateChannel` / `setUpdateChannel` ipcCalls back our updater,
   so the webapp overlay (desktop/web-overlay/update-channel.js, shipped as
   plotina-update-channel.js) can show and switch the opt-in Dev update
   channel (Settings -> Help & About). Unknown channels return null; the
   second setUpdateChannel argument is the user-confirmed "return to stable"
   downgrade flag (desktop/updater.ts enforces that it is a running -dev
   build before honouring it).

4. electron-builder.ts + src/build-config.ts + src/electron-main.ts +
   src/protocol.ts — the whole `protocols` list from build.plotina.json reaches
   the shell and is registered, not only protocols[0] and the legacy `element`.
   electron-builder applies its own `protocols` config to macOS bundles and
   Linux .desktop files only, so on Windows this handler is the one thing that
   can claim cc.plotina.element; without it the variant advertises a scheme
   registered nowhere (QA `protocol:declared` NOT-REGISTERED) and
   cc.plotina.element:// links open the browser. The list normalisation and the
   registration/deeplink predicates live in desktop/protocol-schemes.ts (copied
   into src next to the other Plotina sources) so they are unit-tested instead
   of only grep-asserted.
"""
import sys
from pathlib import Path

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("src")


def patch(path: Path, pairs: list[tuple[str, str, int]]) -> None:
    text = path.read_text(encoding="utf-8")
    for old, new, count in pairs:
        if new in text:
            continue  # already applied (idempotent)
        found = text.count(old)
        if found != count:
            sys.exit(f"patch-shell.py: {path.name}: expected {count} occurrence(s) of "
                     f"{old!r:.90}, found {found}; upstream moved - update the patch")
        text = text.replace(old, new)
    path.write_text(text, encoding="utf-8")
    print(f"patch-shell.py: {path} OK")


main = SRC / "electron-main.ts"
patch(main, [
    ('import { getIconPath } from "./icon.js";',
     'import { getIconPath, getMainWindowIcon } from "./icon.js";', 1),
    ("icon: await getIconPath(),",
     "icon: await getMainWindowIcon(),  // PLOTINA-SHELL-PATCH: X11 _NET_WM_ICON size limit", 1),
    ("const protocolHandler = new ProtocolHandler(buildConfig.protocol);",
     "// PLOTINA-SHELL-PATCH: pass the variant's full scheme list (see\n"
     "// protocol-schemes.ts); upstream registers only protocols[0] and `element`.\n"
     "const protocolHandler = new ProtocolHandler(buildConfig.protocol, buildConfig.protocols);", 1),
])

ipc = SRC / "ipc.ts"
patch(ipc, [
    ('import { getConfig } from "./config.js";',
     'import { getConfig } from "./config.js";\n'
     'import { getUpdateChannel, getUpdateFeedUrl, setUpdateChannel } from "./updater.js";  // PLOTINA-SHELL-PATCH', 1),
    ('case "getUpdateFeedUrl":\n            ret = autoUpdater.getFeedURL();',
     'case "getUpdateFeedUrl":\n            // PLOTINA-SHELL-PATCH: autoUpdater is Squirrel/macOS only; our NSIS +\n'
     '            // AppImage updater has a real feed, so the webapp can show its\n'
     '            // "Check for updates" button on Linux too (upstream\'s call throws\n'
     '            // there, which hid the button even though updates worked).\n'
     '            ret = getUpdateFeedUrl();\n            break;\n\n'
     '        case "getUpdateChannel":\n'
     '            // PLOTINA-SHELL-PATCH: opt-in Dev update channel, answered by\n'
     '            // desktop/updater.ts; the webapp overlay wires it to Settings\n'
     '            // -> Help & About (default "stable").\n'
     '            ret = getUpdateChannel();\n            break;\n\n'
     '        case "setUpdateChannel":\n'
     '            // PLOTINA-SHELL-PATCH: args [channel, allowDowngrade];\n'
     '            // allowDowngrade is the user-confirmed "Вернуться на стабильный"\n'
     '            // and only applies to a running -dev build (see updater.ts).\n'
     '            ret = setUpdateChannel(String(args[0]), args[1] === true);', 1),
])

build_config = SRC / "build-config.ts"
patch(build_config, [
    ("interface BuildConfig {\n"
     "    // Application User Model ID\n"
     "    appId: string;\n"
     "    // Protocol string used for OIDC callbacks\n"
     "    protocol: string;",
     "interface BuildConfig {\n"
     "    // Application User Model ID\n"
     "    appId: string;\n"
     "    // Protocol string used for OIDC callbacks\n"
     "    protocol: string;\n"
     "    // PLOTINA-SHELL-PATCH: every scheme the variant declares, from the\n"
     "    // comma-separated electron_protocols electron-builder.ts writes out of\n"
     "    // build.plotina.json protocols[]. `protocol` stays protocols[0].\n"
     "    protocols: string[];", 1),
    ('            protocol: (packageJson["electron_protocol"] as string) || "io.element.desktop",',
     '            protocol: (packageJson["electron_protocol"] as string) || "io.element.desktop",\n'
     '            // PLOTINA-SHELL-PATCH: without this the shell registers only\n'
     '            // protocols[0], so a variant-declared scheme such as\n'
     '            // cc.plotina.element is advertised but claimed by nobody.\n'
     '            protocols: String(packageJson["electron_protocols"] || "")\n'
     '                .split(",")\n'
     '                .map((scheme) => scheme.trim())\n'
     '                .filter(Boolean),', 1),
])

protocol = SRC / "protocol.ts"
patch(protocol, [
    ('import { type Args, getArgsForProtocolRegistration } from "./args.js";\n'
     '\n'
     'const LEGACY_PROTOCOL = "element";\n',
     'import { type Args, getArgsForProtocolRegistration } from "./args.js";\n'
     '// PLOTINA-SHELL-PATCH: register and accept every scheme the variant\n'
     '// declares, not only protocols[0] + the legacy `element` scheme; the list\n'
     '// logic (and its tests) lives in desktop/protocol-schemes.ts.\n'
     'import {\n'
     '    isSchemeProtocol,\n'
     '    isSchemeUrl,\n'
     '    protocolSchemeList,\n'
     '    registerProtocolSchemes,\n'
     '} from "./protocol-schemes.js";\n', 1),
    ("    private readonly store: Record<string, string> = {};\n"
     "    private readonly sessionId: string;\n"
     "\n"
     "    public constructor(private readonly protocol: string) {\n",
     "    private readonly store: Record<string, string> = {};\n"
     "    private readonly sessionId: string;\n"
     "    // PLOTINA-SHELL-PATCH: protocols[0] + `element` + everything else the\n"
     "    // variant declares (electron_protocols in the packaged package.json).\n"
     "    private readonly schemes: string[];\n"
     "\n"
     "    public constructor(private readonly protocol: string, declaredProtocols: string[] = []) {\n"
     "        this.schemes = protocolSchemeList(this.protocol, declaredProtocols);\n", 1),
    ("    private checkArgIsUrl = (arg: string): boolean => {\n"
     "        return arg.startsWith(`${this.protocol}:/`) || arg.startsWith(`${LEGACY_PROTOCOL}://`);\n"
     "    };",
     "    private checkArgIsUrl = (arg: string): boolean => {\n"
     "        return isSchemeUrl(arg, this.schemes);\n"
     "    };", 1),
    ("        const args = getArgsForProtocolRegistration(parsedArgs);\n"
     "        if (app.isPackaged) {\n"
     "            app.setAsDefaultProtocolClient(this.protocol, process.execPath, args);\n"
     "            app.setAsDefaultProtocolClient(LEGACY_PROTOCOL, process.execPath, args);\n"
     "        } else if (process.platform === \"win32\") {\n",
     "        const args = getArgsForProtocolRegistration(parsedArgs);\n"
     "        // PLOTINA-SHELL-PATCH: claim every scheme of the variant. On Windows\n"
     "        // this write is what makes a scheme real: electron-builder does not\n"
     "        // register protocols in its NSIS installer (macOS/Linux only).\n"
     "        if (app.isPackaged) {\n"
     "            registerProtocolSchemes(app, this.schemes, process.execPath, args);\n"
     "        } else if (process.platform === \"win32\") {\n", 1),
    ("            app.setAsDefaultProtocolClient(this.protocol, process.execPath, [app.getAppPath(), ...args]);\n"
     "            app.setAsDefaultProtocolClient(LEGACY_PROTOCOL, process.execPath, [app.getAppPath(), ...args]);\n",
     "            registerProtocolSchemes(app, this.schemes, process.execPath, [app.getAppPath(), ...args]);\n", 1),
    ("        if (parsed.protocol !== `${this.protocol}:` && parsed.protocol !== `${LEGACY_PROTOCOL}:`) {\n",
     "        if (!isSchemeProtocol(parsed.protocol, this.schemes)) {\n", 1),
    ("        const deeplinkUrl = args.find(\n"
     "            (arg) => arg.startsWith(`${this.protocol}:/`) || arg.startsWith(`${LEGACY_PROTOCOL}://`),\n"
     "        );\n",
     "        const deeplinkUrl = args.find((arg) => isSchemeUrl(arg, this.schemes));\n", 1),
    ("            if (parsedUrl.protocol === `${this.protocol}:` || parsedUrl.protocol === `${LEGACY_PROTOCOL}:`) {\n",
     "            if (isSchemeProtocol(parsedUrl.protocol, this.schemes)) {\n", 1),
])

# electron-builder.ts sits next to src/ (apps/desktop/electron-builder.ts): it
# turns the variant into package.json extraMetadata, which is what the packaged
# app reads back at runtime.
builder = SRC.parent / "electron-builder.ts"
patch(builder, [
    ("        electron_appId: variant.appId,\n"
     "        electron_protocol: variant.protocols[0],",
     "        electron_appId: variant.appId,\n"
     "        electron_protocol: variant.protocols[0],\n"
     "        // PLOTINA-SHELL-PATCH: hand the shell the whole variant protocol\n"
     "        // list (read back in src/build-config.ts). electron-builder's own\n"
     "        // `protocols` option only covers macOS bundles and Linux .desktop\n"
     "        // files, so the runtime registration in src/protocol.ts is what\n"
     "        // claims the schemes on Windows.\n"
     "        electron_protocols: variant.protocols.join(\",\"),", 1),
])

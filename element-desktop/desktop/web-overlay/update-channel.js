/*
Copyright 2026 Plotina <thebob3r@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only

Plotina Desktop webapp overlay: the opt-in Dev update channel in
Settings -> Help & About, next to the existing "Check for updates" button.

This file is copied by element-desktop/scripts/prepare-webapp.sh to
<webapp>/plotina-update-channel.js and loaded from index.html. It talks to
the main process through the shell's generic ipcCall bridge (apps/desktop
ipc.ts, patched by desktop/patch-shell.py):

  ipcCall("getUpdateChannel")                 -> "stable" | "dev"
  ipcCall("setUpdateChannel", [ch, confirm])  -> applied channel | null
  ipcCall("getAppVersion")                    -> the running app version

Main-process rules this UI mirrors (desktop/updater.ts): dev is opt-in,
stable is the default; a plain switch never installs anything; switching back
to stable from a running "-dev.<N>" build needs the explicit
"Вернуться на стабильный" confirmation because the newest stable release is
usually a version reduction — the updater then downloads/verifies it through
the same sha512+size pipeline and shows the normal restart dialog. Nothing
here ever restarts the app by itself.

The DOM injection follows the same anchors/observer pattern as noise/boot.js
(the audio-settings row): locate by exact visible text, insert once, re-inject
after re-renders. On Element Web (chat.plotina.cc) window.electron does not
exist, so this file stays inert.
*/
(function () {
    "use strict";

    var STRINGS = {
        ru: {
            label: "Канал обновлений:",
            stable: "Стабильный",
            dev: "Dev",
            devWarning: "Dev-канал: тестовые сборки из main, могут быть нестабильны.",
            returnTitle: "Вы используете Dev-сборку.",
            returnHint: "Возврат на стабильный установит более раннюю стабильную версию после перезапуска.",
            returnButton: "Вернуться на стабильный",
            applied: "Канал переключён. Проверка обновлений начата.",
            version: "Версия:",
            restartNote: "Перезапустите Plotina Desktop, чтобы установить обновление.",
        },
        en: {
            label: "Update channel:",
            stable: "Stable",
            dev: "Dev",
            devWarning: "Dev channel: test builds from main; they may be unstable.",
            returnTitle: "You are running a Dev build.",
            returnHint: "Returning to stable installs the older stable release after a restart.",
            returnButton: "Return to stable",
            applied: "Channel switched. Checking for updates now.",
            version: "Version:",
            restartNote: "Restart Plotina Desktop to install the update.",
        },
    };

    function strings() {
        var lang = document.documentElement.lang || navigator.language || "";
        return /^ru/i.test(lang) ? STRINGS.ru : STRINGS.en;
    }

    // Exact texts of the "Check for updates" control (update|check_action).
    var BUTTON_LABELS = ["Проверить наличие обновлений", "Check for update"];

    var CHANNEL_KEY = "plotina-update-channel-row";
    var channel = "stable";
    var appVersion = "";
    var probed = false;

    if (!window.electron || typeof window.electron.send !== "function") return;

    /* ---------------------------------------------------------------- ipc */

    var seq = 0;
    var waiting = {};
    window.electron.on("ipcReply", function (_event, payload) {
        if (!payload || !waiting[payload.id]) return;
        var w = waiting[payload.id];
        delete waiting[payload.id];
        if (payload.error) w.reject(new Error(String(payload.error.message || payload.error)));
        else w.resolve(payload.reply);
    });

    function ipcCall(name, args) {
        return new Promise(function (resolve, reject) {
            var id = "plotina-ch-" + ++seq + "-" + Date.now();
            waiting[id] = { resolve: resolve, reject: reject };
            setTimeout(function () {
                if (waiting[id]) {
                    delete waiting[id];
                    reject(new Error("ipcCall timeout: " + name));
                }
            }, 8000);
            try {
                window.electron.send("ipcCall", { id: id, name: name, args: args || [] });
            } catch (e) {
                delete waiting[id];
                reject(e);
            }
        });
    }

    function probe() {
        if (probed) return;
        probed = true;
        ipcCall("getUpdateChannel")
            .then(function (c) {
                if (c === "dev" || c === "stable") {
                    channel = c;
                    syncChannelUI();
                }
            })
            .catch(function () {
                probed = false;
            });
        ipcCall("getAppVersion")
            .then(function (v) {
                if (typeof v === "string" && v) {
                    appVersion = v;
                    syncChannelUI();
                }
            })
            .catch(function () {});
    }

    function isRunningDevBuild() {
        return /[-~]dev\.\d/.test(appVersion);
    }

    function setChannel(next, confirmDowngrade) {
        return ipcCall("setUpdateChannel", [next, confirmDowngrade === true]).then(function (applied) {
            if (applied === "stable" || applied === "dev") channel = applied;
            syncChannelUI();
            return applied;
        });
    }

    /* ----------------------------------------------------------------- ui */

    function exactTextNode(labels) {
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        var node;
        while ((node = walker.nextNode())) {
            if (node.nodeValue && labels.indexOf(node.nodeValue.trim()) !== -1) {
                var el = node.parentElement;
                if (el && el.offsetParent !== null) return el;
            }
        }
        return null;
    }

    function findAnchor() {
        // Preferred: the row with the "Check for updates" button itself.
        var el = exactTextNode(BUTTON_LABELS);
        if (el) {
            var row = el;
            for (var d = 0; d < 6 && row.parentElement; d++) {
                row = row.parentElement;
                var r = row.getBoundingClientRect ? row.getBoundingClientRect() : null;
                if (r && r.height > 24 && row.querySelector("button, [role=\"button\"], a")) break;
            }
            return row;
        }
        // Fallback: the Help & About section heading block.
        var heading = exactTextNode(["Помощь и о программе", "Help & About"]);
        if (heading && heading.parentElement) return heading.parentElement;
        return null;
    }

    var refs = {};

    function syncChannelUI() {
        var s = strings();
        if (!refs.select) return;
        if (refs.select.value !== channel) refs.select.value = channel;
        refs.warning.textContent = channel === "dev" ? s.devWarning : "";
        refs.warning.style.display = channel === "dev" ? "" : "none";
        var needsConfirm = channel !== "stable" && pendingStableReturn;
        refs.confirm.style.display = needsConfirm && isRunningDevBuild() ? "" : "none";
        refs.confirmHint.textContent = needsConfirm && isRunningDevBuild() ? s.returnHint : "";
        refs.appliedNote.style.display = appliedNote ? "" : "none";
        refs.appliedNote.textContent = appliedNote;
        if (refs.version) refs.version.textContent = appVersion ? s.version + " " + appVersion : "";
    }

    var pendingStableReturn = false;
    var appliedNote = "";

    function buildRow() {
        var s = strings();
        var row = document.createElement("div");
        row.id = CHANNEL_KEY;
        row.style.cssText = [
            "display:flex", "flex-wrap:wrap", "align-items:center", "gap:8px 12px",
            "margin:10px 0 4px", "max-width:560px", "font:inherit",
        ].join(";");

        var label = document.createElement("span");
        label.textContent = s.label;

        var select = document.createElement("select");
        select.setAttribute("aria-label", s.label);
        select.style.cssText = "font:inherit;background:transparent;color:inherit;border:1px solid rgba(128,128,128,.5);border-radius:6px;padding:2px 6px;";
        [["stable", s.stable], ["dev", s.dev]].forEach(function (o) {
            var opt = document.createElement("option");
            opt.value = o[0];
            opt.textContent = o[1];
            select.appendChild(opt);
        });
        select.value = channel;

        var warning = document.createElement("div");
        warning.style.cssText = "flex-basis:100%;font-size:12px;opacity:.75;";

        var confirmWrap = document.createElement("div");
        confirmWrap.style.cssText = "flex-basis:100%;display:flex;align-items:center;gap:10px;flex-wrap:wrap;";
        var confirm = document.createElement("button");
        confirm.type = "button";
        confirm.textContent = s.returnButton;
        confirm.style.cssText = "font:inherit;border:1px solid rgba(128,128,128,.6);border-radius:8px;padding:4px 10px;background:transparent;color:inherit;cursor:pointer;";
        var confirmHint = document.createElement("span");
        confirmHint.style.cssText = "font-size:12px;opacity:.75;";

        var appliedNoteEl = document.createElement("div");
        appliedNoteEl.style.cssText = "flex-basis:100%;font-size:12px;opacity:.8;";

        var version = document.createElement("span");
        version.style.cssText = "font-size:12px;opacity:.7;";

        select.addEventListener("change", function () {
            var next = select.value;
            appliedNote = "";
            if (next === "dev") {
                pendingStableReturn = false;
                setChannel("dev", false).then(function () {
                    appliedNote = strings().devWarning;
                    syncChannelUI();
                });
            } else if (isRunningDevBuild()) {
                // Version reduction needs an explicit confirmation: keep the
                // select on dev until the user presses the confirm button.
                pendingStableReturn = true;
                select.value = "dev";
                syncChannelUI();
            } else {
                pendingStableReturn = false;
                setChannel("stable", false).then(function () {
                    appliedNote = strings().applied;
                    syncChannelUI();
                });
            }
        });

        confirm.addEventListener("click", function () {
            pendingStableReturn = false;
            setChannel("stable", true).then(function () {
                appliedNote = strings().restartNote;
                syncChannelUI();
            });
        });

        refs = { select: select, warning: warning, confirm: confirm, confirmHint: confirmHint, appliedNote: appliedNoteEl, version: version };

        row.appendChild(label);
        row.appendChild(select);
        row.appendChild(version);
        row.appendChild(warning);
        row.appendChild(confirmWrap);
        confirmWrap.appendChild(confirm);
        confirmWrap.appendChild(confirmHint);
        row.appendChild(appliedNoteEl);
        syncChannelUI();
        return row;
    }

    function inject() {
        var existing = document.getElementById(CHANNEL_KEY);
        if (existing) {
            if (existing.isConnected) {
                syncChannelUI();
                return;
            }
            existing.remove();
        }
        var anchor = findAnchor();
        if (!anchor) return;
        probe();
        anchor.insertAdjacentElement("afterend", buildRow());
    }

    var pending = false;
    function scheduleInject() {
        if (pending) return;
        pending = true;
        setTimeout(function () {
            pending = false;
            try {
                inject();
            } catch (e) {
                console.warn("plotina-update-channel: injection failed", e);
            }
        }, 200);
    }

    new MutationObserver(scheduleInject).observe(document.documentElement, { childList: true, subtree: true });
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", scheduleInject, { once: true });
    } else {
        scheduleInject();
    }
})();

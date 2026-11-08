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
            updatesTab: "Обновления",
            updatesTitle: "Обновления",
            checkButton: "Проверить наличие обновлений",
            checking: "Проверяю обновления…",
            checkingButton: "Проверяю…",
            checkHint: "Проверяю обновления… Если найдётся обновление, появится системный диалог.",
            checkTimeout: "Проверка занимает дольше обычного. Проверьте соединение или попробуйте ещё раз.",
            noUpdates: "Обновлений нет — установлена последняя версия.",
            updateFound: "Обновление найдено, скачивается…",
            updateDownloaded: "Обновление скачано. Перезапустите Plotina Desktop, чтобы установить его.",
            channelHeading: "Канал обновлений",
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
            updatesTab: "Updates",
            updatesTitle: "Updates",
            checkButton: "Check for updates",
            checking: "Checking for updates…",
            checkingButton: "Checking…",
            checkHint: "Checking for updates… If an update is found, a system dialog will appear.",
            checkTimeout: "The check is taking longer than usual. Check your connection and try again.",
            noUpdates: "You are up to date.",
            updateFound: "Update found, downloading…",
            updateDownloaded: "Update downloaded. Restart Plotina Desktop to install it.",
            channelHeading: "Update channel",
        },
    };

    function strings() {
        var lang = document.documentElement.lang || navigator.language || "";
        return /^ru/i.test(lang) ? STRINGS.ru : STRINGS.en;
    }

    // Exact texts of the "Check for updates" control (update|check_action).
    var BUTTON_LABELS = ["Проверить наличие обновлений", "Check for update"];

    var CHANNEL_KEY = "plotina-update-channel-row";
    var TAB_KEY = "plotina-updates-tab";
    var PANEL_KEY = "plotina-updates-panel";
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
        refs.select.textContent = (channel === "dev" ? s.dev : s.stable) + " \u25be";
        Object.keys(refs.optionButtons || {}).forEach(function (key) {
            var selected = key === channel;
            var option = refs.optionButtons[key];
            option.setAttribute("aria-selected", selected ? "true" : "false");
            option.style.background = selected ? "var(--cpd-color-bg-action-primary,#0dbd8b)" : "transparent";
            option.style.color = selected ? "var(--cpd-color-text-on-solid-primary,#fff)" : "inherit";
        });
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

        // Native <select> popups ignore the app theme on Linux (and use the
        // system's blue selection), so the channel choice is a small custom
        // menu that follows Element's theme tokens.
        var control = document.createElement("div");
        control.style.cssText = "position:relative;display:inline-block;";
        var trigger = document.createElement("button");
        trigger.type = "button";
        trigger.setAttribute("aria-haspopup", "listbox");
        trigger.setAttribute("aria-label", s.label);
        trigger.style.cssText = [
            "font:inherit", "color:var(--cpd-color-text-primary,#f2f3f5)",
            "background:var(--cpd-color-bg-subtle-primary,#242832)",
            "border:1px solid var(--cpd-color-border-interactive-primary,#5a6270)",
            "border-radius:6px", "padding:3px 9px", "cursor:pointer",
        ].join(";");
        var menu = document.createElement("div");
        menu.setAttribute("role", "listbox");
        menu.style.cssText = [
            "display:none", "position:absolute", "left:0", "top:calc(100% + 4px)",
            "min-width:150px", "z-index:2147483647", "padding:4px",
            "background:var(--cpd-color-bg-subtle-primary,#242832)",
            "color:var(--cpd-color-text-primary,#f2f3f5)",
            "border:1px solid var(--cpd-color-border-interactive-primary,#5a6270)",
            "border-radius:8px", "box-shadow:0 8px 24px rgba(0,0,0,.35)",
        ].join(";");
        var optionButtons = {};
        var open = false;
        function setOpen(next) {
            open = next;
            menu.style.display = open ? "block" : "none";
            trigger.setAttribute("aria-expanded", open ? "true" : "false");
        }
        function choose(next) {
            setOpen(false);
            appliedNote = "";
            if (next === "dev") {
                pendingStableReturn = false;
                setChannel("dev", false).then(function () {
                    // The channel warning is already rendered by syncChannelUI()
                    // for channel=dev; do not repeat it in the applied note.
                    appliedNote = "";
                    syncChannelUI();
                });
            } else if (isRunningDevBuild()) {
                // Version reduction needs an explicit confirmation: keep the
                // current dev channel until the user presses the button.
                pendingStableReturn = true;
                syncChannelUI();
            } else {
                pendingStableReturn = false;
                setChannel("stable", false).then(function () {
                    appliedNote = strings().applied;
                    syncChannelUI();
                });
            }
        }
        [["stable", s.stable], ["dev", s.dev]].forEach(function (item) {
            var option = document.createElement("button");
            option.type = "button";
            option.setAttribute("role", "option");
            option.textContent = item[1];
            option.style.cssText = [
                "display:block", "width:100%", "text-align:left", "font:inherit",
                "color:inherit", "background:transparent", "border:0",
                "border-radius:5px", "padding:6px 9px", "cursor:pointer",
            ].join(";");
            option.addEventListener("click", function () { choose(item[0]); });
            optionButtons[item[0]] = option;
            menu.appendChild(option);
        });
        trigger.addEventListener("click", function (event) {
            event.stopPropagation();
            setOpen(!open);
        });
        document.addEventListener("click", function (event) {
            if (!control.contains(event.target)) setOpen(false);
        });
        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape") setOpen(false);
        });
        control.appendChild(trigger);
        control.appendChild(menu);

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

        confirm.addEventListener("click", function () {
            pendingStableReturn = false;
            setChannel("stable", true).then(function () {
                appliedNote = strings().restartNote;
                syncChannelUI();
            });
        });

        refs = { select: trigger, menu: menu, optionButtons: optionButtons, warning: warning,
                 confirm: confirm, confirmHint: confirmHint, appliedNote: appliedNoteEl, version: version };

        row.appendChild(label);
        row.appendChild(control);
        row.appendChild(version);
        row.appendChild(warning);
        row.appendChild(confirmWrap);
        confirmWrap.appendChild(confirm);
        confirmWrap.appendChild(confirmHint);
        row.appendChild(appliedNoteEl);
        syncChannelUI();
        return row;
    }
    function settingsRoot() {
        return document.querySelector(".mx_UserSettingsDialog");
    }

    function hideNativeUpdateButton() {
        // The upstream Check-for-updates button lives in Help & About. Updates
        // now have their own tab, so remove that row from the old tab.
        var el = exactTextNode(BUTTON_LABELS);
        if (!el) return;
        if (el.closest && el.closest("#" + PANEL_KEY)) return; // our own check button
        var row = el;
        for (var d = 0; d < 5 && row.parentElement; d++) {
            row = row.parentElement;
            if (row.querySelector && row.querySelector("button, [role=\"button\"]")) break;
        }
        if (row && row !== document.body) row.style.display = "none";
    }

    function buildTabLabel(s) {
        var label = document.createElement("li");
        label.id = TAB_KEY;
        label.className = "mx_TabbedView_tabLabel";
        label.setAttribute("role", "tab");
        label.setAttribute("aria-selected", "false");
        label.setAttribute("aria-controls", PANEL_KEY);
        label.tabIndex = 0;
        label.style.cursor = "pointer";
        var icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("width", "24");
        icon.setAttribute("height", "24");
        icon.setAttribute("aria-hidden", "true");
        icon.setAttribute("focusable", "false");
        icon.innerHTML = '<path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>';
        label.appendChild(icon);
        var text = document.createElement("span");
        text.className = "mx_TabbedView_tabLabel_text";
        text.textContent = s.updatesTab;
        label.appendChild(text);
        label.addEventListener("click", function (event) {
            event.preventDefault();
            activateTab();
        });
        label.addEventListener("keydown", function (event) {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                activateTab();
            }
        });
        return label;
    }

    function activateTab() {
        var root = settingsRoot();
        if (!root) return;
        root.querySelectorAll(".mx_TabbedView_tabLabel").forEach(function (el) {
            var active = el.id === TAB_KEY;
            el.classList.toggle("mx_TabbedView_tabLabel_active", active);
            el.setAttribute("aria-selected", active ? "true" : "false");
        });
        root.querySelectorAll(".mx_TabbedView_tabPanel").forEach(function (el) {
            el.style.display = el.id === PANEL_KEY ? "" : "none";
        });
        var panel = document.getElementById(PANEL_KEY);
        if (panel) panel.style.display = "";
    }

    function buildPanel(s) {
        var panel = document.createElement("div");
        panel.className = "mx_TabbedView_tabPanel";
        panel.id = PANEL_KEY;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", TAB_KEY);
        panel.style.display = "none";

        var scroll = document.createElement("div");
        scroll.className = "mx_AutoHideScrollbar mx_TabbedView_tabPanelContent";
        var tab = document.createElement("div");
        tab.className = "mx_SettingsTab";
        tab.style.padding = "24px 32px";
        tab.style.maxWidth = "680px";

        var heading = document.createElement("div");
        heading.className = "mx_SettingsTab_heading";
        heading.textContent = s.updatesTitle;
        heading.style.cssText = "font-size:20px;font-weight:600;margin:0 0 20px;color:var(--cpd-color-text-primary,#f2f3f5);";

        var checkSection = document.createElement("div");
        checkSection.className = "mx_SettingsTab_section";
        checkSection.style.marginBottom = "24px";
        var check = document.createElement("button");
        check.type = "button";
        check.textContent = s.checkButton;
        check.className = "mx_AccessibleButton mx_AccessibleButton_kind_primary";
        check.style.cssText = "font:inherit;background:var(--cpd-color-bg-action-primary,#0dbd8b);color:var(--cpd-color-text-on-solid-primary,#fff);border:0;border-radius:8px;padding:8px 14px;cursor:pointer;";
        var status = document.createElement("div");
        status.setAttribute("aria-live", "polite");
        status.style.cssText = "font-size:12px;opacity:.7;margin-top:8px;min-height:16px;";
        var checkBusy = false;
        var checkTimer = null;
        function setCheckBusy(busy, note) {
            checkBusy = busy;
            check.disabled = busy;
            check.setAttribute("aria-busy", busy ? "true" : "false");
            check.textContent = busy ? s.checkingButton : s.checkButton;
            if (note !== undefined) status.textContent = note;
            if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
            if (busy) {
                checkTimer = setTimeout(function () {
                    if (checkBusy) setCheckBusy(false, s.checkTimeout);
                }, 60000);
            }
        }
        check.addEventListener("click", function () {
            setCheckBusy(true, s.checkHint);
            try { window.electron.send("check_updates"); } catch (e) { setCheckBusy(false, String(e)); }
        });
        checkSection.appendChild(check);
        checkSection.appendChild(status);
        if (window.electron && typeof window.electron.on === "function") {
            window.electron.on("check_updates", function (_event, result) {
                if (result === false) setCheckBusy(false, s.noUpdates);
                else if (result === true) setCheckBusy(true, s.updateFound);
                else if (typeof result === "string" && result) setCheckBusy(false, result);
            });
            window.electron.on("update-downloaded", function (_event, info) {
                var name = info && info.releaseName ? " (" + info.releaseName + ")" : "";
                setCheckBusy(false, s.updateDownloaded + name);
            });
        }

        var channelSection = document.createElement("div");
        channelSection.className = "mx_SettingsTab_section";
        var channelHeading = document.createElement("div");
        channelHeading.textContent = s.channelHeading;
        channelHeading.style.cssText = "font-size:16px;font-weight:600;margin:0 0 8px;";
        channelSection.appendChild(channelHeading);
        channelSection.appendChild(buildRow());

        tab.appendChild(heading);
        tab.appendChild(checkSection);
        tab.appendChild(channelSection);
        scroll.appendChild(tab);
        panel.appendChild(scroll);
        return panel;
    }

    function inject() {
        var root = settingsRoot();
        if (!root) return;
        var tabList = root.querySelector(".mx_TabbedView_tabLabels");
        var tabbedView = root.querySelector(".mx_TabbedView");
        if (!tabList || !tabbedView) return;

        hideNativeUpdateButton();
        var s = strings();
        var existingLabel = document.getElementById(TAB_KEY);
        if (!existingLabel || !existingLabel.isConnected) {
            if (existingLabel) existingLabel.remove();
            tabList.appendChild(buildTabLabel(s));
        }
        var existingPanel = document.getElementById(PANEL_KEY);
        if (!existingPanel || !existingPanel.isConnected) {
            if (existingPanel) existingPanel.remove();
            tabbedView.appendChild(buildPanel(s));
        }
        if (!tabList.__plotinaUpdatesListener) {
            tabList.__plotinaUpdatesListener = true;
            tabList.addEventListener("click", function (event) {
                var own = event.target.closest && event.target.closest("#" + TAB_KEY);
                var panel = document.getElementById(PANEL_KEY);
                if (!own && panel) panel.style.display = "none";
                if (!own && existingLabel) {
                    existingLabel.classList.remove("mx_TabbedView_tabLabel_active");
                    existingLabel.setAttribute("aria-selected", "false");
                }
            }, true);
        }
        if (!refs.select) return;
        probe();
    }

    var pending = false;
    function scheduleInject() {
        if (pending) return;
        pending = true;
        // Run in the MutationObserver microtask, before the browser paints the
        // newly opened settings dialog. The old 200 ms delay let the native
        // tab list paint first, so "Обновления" popped in visibly afterwards.
        Promise.resolve().then(function () {
            pending = false;
            try {
                inject();
            } catch (e) {
                console.warn("plotina-update-channel: injection failed", e);
            }
        });
    }

    new MutationObserver(scheduleInject).observe(document.documentElement, { childList: true, subtree: true });
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", scheduleInject, { once: true });
    } else {
        scheduleInject();
    }
})();

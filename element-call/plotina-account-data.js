/*
Copyright 2026 Plotina <thebob3r@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only

Account-data sender for Element Call running inside a Matrix widget.

Why this file exists. Patch 0004 (per-participant volume) writes
cc.plotina.voice_volumes with client.setAccountData(). Inside a widget that
client is matrix-js-sdk's RoomWidgetClient, which was created from
baseUrl/userId/deviceId only and has no access token, so the write can only ever
answer 401. matrix-widget-api 1.20 has no write-account-data action either: the
only account-data verb is com.beeper.read_room_account_data (a read), and
WidgetDriver exposes readRoomAccountData() without a writer.

A custom action is the protocol's normal extension point, not a workaround
(WidgetApiAction is `WidgetApiToWidgetAction | WidgetApiFromWidgetAction |
string`, and ClientWidgetApi emits `action:<name>` for the host to
preventDefault()). Element Call itself sends io.element.join /
im.vector.hangup the same way. So the frame sends
  cc.plotina.set_account_data  { type, content }
and the host (Cinny's CallWidgetDriver) performs the write with the app's
authenticated MatrixClient.

Loaded from index.html before the app bundle, so the setter below is in place
before Element Call assigns window.matrixclient. Stands down outside a widget
(call.plotina.cc in a browser, where the client has a token of its own) and when
the bundle already sends the action itself (archives built with EC patch 0006).
*/
(function () {
  "use strict";

  var ACTION = "cc.plotina.set_account_data";
  var TIMEOUT_MS = 15000;
  // Only the volume map. Room state is not account data and is refused on the
  // host side; keeping the allow-list here too means a stray call from a future
  // patch never turns into a silent write of something else.
  var TYPES = { "cc.plotina.voice_volumes": true };

  if (window.PlotinaAccountData) return;

  function params() {
    var out = {};
    var sources = [window.location.search || "", window.location.hash || ""];
    for (var i = 0; i < sources.length; i++) {
      var raw = sources[i].replace(/^#?\/?/, "").replace(/^\?/, "");
      if (!raw) continue;
      var parts = raw.split("&");
      for (var j = 0; j < parts.length; j++) {
        var pair = parts[j].split("=");
        if (pair.length !== 2) continue;
        try {
          out[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1]);
        } catch (e) {
          /* malformed escape: skip the pair */
        }
      }
    }
    return out;
  }

  var query = params();
  var widgetId = query.widgetId || "";
  var parentUrl = query.parentUrl || "";
  var embedded = !!(widgetId && parentUrl) && window.parent !== window;

  var pending = new Map();
  var seq = 0;

  function targetOrigin() {
    try {
      return new URL(parentUrl).origin;
    } catch (e) {
      return "*";
    }
  }

  function settle(message) {
    var entry = pending.get(message.requestId);
    if (!entry) return false;
    pending.delete(message.requestId);
    if (entry.timer) window.clearTimeout(entry.timer);
    // matrix-widget-api answers an action by echoing the request with a
    // `response` field (PostmessageTransport.reply); a toWidget envelope is
    // only used for host-initiated actions.
    var payload = message.response !== undefined ? message.response : message.data;
    var error = payload && payload.error;
    if (error) entry.reject(new Error(error.message || "widget refused the write"));
    else entry.resolve(payload || {});
    return true;
  }

  function onMessage(event) {
    var message = event && event.data;
    if (!message || !message.requestId) return;
    if (!pending.has(message.requestId)) return;
    if (message.widgetId && message.widgetId !== widgetId) return;
    settle(message);
  }

  function send(action, data) {
    return new Promise(function (resolve, reject) {
      var requestId = "plotina-" + ++seq + "-" + Date.now().toString(36);
      var timer = window.setTimeout(function () {
        pending.delete(requestId);
        reject(new Error("widget host did not answer " + action));
      }, TIMEOUT_MS);
      pending.set(requestId, { resolve: resolve, reject: reject, timer: timer });
      window.parent.postMessage(
        { api: "fromWidget", widgetId: widgetId, requestId: requestId, action: action, data: data },
        targetOrigin()
      );
    });
  }

  function wrap(client) {
    if (!client || client.__plotinaAccountData === ACTION) return client;
    var original = client.setAccountData;
    if (typeof original !== "function") return client;
    client.setAccountData = function (type, content) {
      if (!TYPES[type]) return original.apply(this, arguments);
      return send(ACTION, { type: type, content: content });
    };
    try {
      client.__plotinaAccountData = ACTION;
    } catch (e) {
      /* frozen client: the wrapper above still works */
    }
    return client;
  }

  var current;
  try {
    current = window.matrixclient;
  } catch (e) {
    current = undefined;
  }

  window.PlotinaAccountData = { action: ACTION, send: send, embedded: embedded };

  if (!embedded) return;

  window.addEventListener("message", onMessage);

  try {
    Object.defineProperty(window, "matrixclient", {
      configurable: true,
      get: function () {
        return current;
      },
      set: function (client) {
        current = wrap(client);
      },
    });
  } catch (e) {
    /* a defineProperty failure would leave the widget write to 401 again */
    console.error("plotina: cannot intercept window.matrixclient", e);
  }
})();

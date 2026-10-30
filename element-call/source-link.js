/*
 * Plotina: add the source link to Element Call's footer.
 *
 * Element Call v0.26.1 has no configurable footer. The unauthenticated view
 * renders a <footer>; the call and lobby views do not (their controls use
 * data-testid="footer-container"), so appending here shows the link on the
 * sign-in/registration page and leaves the call UI alone.
 *
 * React renders the footer after this deferred script runs, so a
 * MutationObserver waits for it. The link is added once per footer instance.
 */
(function () {
  "use strict";

  var SOURCE_URL = "https://github.com/plotina-cc/clients";
  var MARKER = "data-plotina-source";
  var pending = false;

  function addLink() {
    var footer = document.querySelector("#root footer");
    if (!footer || footer.querySelector("[" + MARKER + "]")) return;

    var link = document.createElement("a");
    link.href = SOURCE_URL;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = "Исходный код";
    link.setAttribute(MARKER, "");
    link.style.cssText =
      "display:block;margin-top:8px;font-size:12px;color:inherit;opacity:.7";
    footer.appendChild(link);
  }

  function schedule() {
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(function () {
      pending = false;
      addLink();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", addLink, { once: true });
  } else {
    addLink();
  }

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();

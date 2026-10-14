// The submission guard: a Chrome extension whose content scripts run in the page's own world on
// a checkout intent's hosts, in every frame and from document start, in both arms. It blocks the
// buttons that pay or place an order and, optionally, form submission; its network rules block
// payment requests. Each blocked click or submission is counted in a cookie on the page's host,
// which the runner reads from the whole browser after the trial, so an agent that leaves the page
// does not take the count with it.

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BLOCKED_COOKIE = "bench_submit_blocked";

// Runs in the page, so it closes over nothing but its argument.
function guard({ buttons, selectors, form_submit: formSubmit, key }) {
  if (window.__benchGuard) return;
  window.__benchGuard = true;
  const button = new RegExp(buttons, "i");
  const count = (what) => {
    try {
      const current = Number(document.cookie.split("; ").find(c => c.startsWith(`${key}=`))?.slice(key.length + 1) || 0);
      const crossSite = location.protocol === "https:" ? "; SameSite=None; Secure" : "";
      document.cookie = `${key}=${current + 1}; path=/; max-age=86400${crossSite}`;
    } catch {
      // cookies are unavailable in sandboxed frames
    }
    console.warn(`bench guard: blocked ${what}`);
  };
  const stop = (event, what) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (what) count(what);
  };
  const label = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ");
  window.addEventListener("click", (event) => {
    const marked = selectors && event.target?.closest?.(selectors);
    if (marked) return stop(event, `a click on "${label(marked)}" (${selectors})`);
    const el = event.target?.closest?.('button, [role="button"], input[type="submit"], input[type="button"], a');
    if (!el) return;
    if (button.test(label(el))) stop(event, `a click on "${label(el)}"`);
    else if (formSubmit && el.form && el.type === "submit") stop(event, `a click on the submit button "${label(el)}"`);
  }, true);
  if (formSubmit) {
    window.addEventListener("submit", (event) => stop(event, "a form submission"), true);
    // Enter in a field would submit the form; it is blocked but not counted, since agents press it
    // to pick address suggestions.
    window.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target?.form) stop(event, null);
    }, true);
    HTMLFormElement.prototype.submit = function () { count("form.submit()"); };
    HTMLFormElement.prototype.requestSubmit = function () { count("form.requestSubmit()"); };
  }
}

// Network rules apply whichever world or frame starts a request, including the isolated world
// Playwright's page.evaluate runs in, where the page-world overrides above are not installed:
// `requests` blocks matching fetch, XHR and beacons from any frame, and `form_submit` blocks POST
// navigations started on the guard's hosts. Neither is counted.
export function networkRules({ hosts, form_submit: formSubmit = false, requests = null }) {
  const rules = [];
  if (requests) {
    rules.push({ id: 1, priority: 1, action: { type: "block" }, condition: { regexFilter: requests, isUrlFilterCaseSensitive: false, resourceTypes: ["xmlhttprequest", "ping"] } });
  }
  if (formSubmit) {
    const domains = [...new Set(hosts.map(host => new URL(host.replace("://*.", "://")).hostname))];
    rules.push({ id: 2, priority: 1, action: { type: "block" }, condition: { initiatorDomains: domains, requestMethods: ["post"], resourceTypes: ["main_frame", "sub_frame"] } });
  }
  return rules;
}

// The name carries a hash of the content, so a run reuses an extension it, or an earlier run,
// already uploaded.
export function writeGuardExtension(dir, { hosts, buttons, selectors = null, form_submit: formSubmit = false, requests = null }) {
  const rules = networkRules({ hosts, form_submit: formSubmit, requests });
  const files = {
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "bench submission guard",
      version: "1.0",
      content_scripts: [{ matches: hosts, js: ["guard.js"], run_at: "document_start", all_frames: true, world: "MAIN" }],
      ...(rules.length ? { permissions: ["declarativeNetRequest"], declarative_net_request: { rule_resources: [{ id: "guard", enabled: true, path: "rules.json" }] } } : {}),
    }, null, 2) + "\n",
    "guard.js": `(${guard})(${JSON.stringify({ buttons, selectors, form_submit: formSubmit, key: BLOCKED_COOKIE })});\n`,
    ...(rules.length ? { "rules.json": JSON.stringify(rules, null, 2) + "\n" } : {}),
  };
  const hash = createHash("sha256");
  for (const [name, text] of Object.entries(files)) hash.update(`${name}\0${text}\0`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return { name: `bench-guard-${hash.digest("hex").slice(0, 12)}`, dir };
}

// Blocked attempts across every host the guard ran on, from the browser's cookies.
export function blockedAttempts(cookies) {
  return cookies.filter(cookie => cookie.name === BLOCKED_COOKIE).reduce((total, cookie) => total + (Number(cookie.value) || 0), 0);
}

// Host access is narrow by default: the manifest declares no host
// permissions. Installed tools' URL patterns and sites the user asks to
// discover are granted as optional host permissions.

import '../lib/url-pattern.js';

const {chromeMatchPatterns} = globalThis.xw.urlPattern;

export function originsFor(patterns) {
  return chromeMatchPatterns(patterns);
}

export async function grantedOrigins() {
  const {origins = []} = await chrome.permissions.getAll();
  return origins;
}

// pendingOrigins returns the origins that installed tools need but the user
// has not granted. Requesting them needs a user gesture, so the popup asks.
export async function pendingOrigins(definitions) {
  const wanted = originsFor(definitions.flatMap((definition) => definition.match.url_patterns));
  const pending = [];
  for (const origin of wanted) {
    if (!(await chrome.permissions.contains({origins: [origin]}))) pending.push(origin);
  }
  return pending;
}

// grantedSubset keeps only match patterns the extension can inject into.
export async function grantedSubset(patterns) {
  const out = [];
  for (const pattern of patterns) {
    if (await chrome.permissions.contains({origins: [pattern]})) out.push(pattern);
  }
  return out;
}

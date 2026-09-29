// URL pattern matching with the same semantics as the Kernel custom WebMCP
// executor: scheme http|https|*, host exact | * | *.suffix (suffix matches the
// apex too), and a wildcard path matched against pathname + search.

(() => {
  globalThis.xw ??= {};

  function wildcardRegexp(pattern) {
    const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replaceAll('*', '.*');
    return new RegExp(`^${escaped}$`);
  }

  function parseURLPattern(pattern) {
    if (typeof pattern !== 'string') {
      throw new Error('match.url_patterns entries must be strings');
    }
    const separator = pattern.indexOf('://');
    if (separator === -1) {
      throw new Error('match.url_patterns entries must contain ://');
    }
    const scheme = pattern.slice(0, separator);
    if (scheme !== 'http' && scheme !== 'https' && scheme !== '*') {
      throw new Error(`unsupported URL pattern scheme: ${scheme}`);
    }
    const remainder = pattern.slice(separator + 3);
    const pathStart = remainder.indexOf('/');
    if (pathStart === -1) {
      throw new Error('match.url_patterns entries must include a path');
    }
    const host = remainder.slice(0, pathStart).toLowerCase();
    if (!host || (host.includes('*') && host !== '*' && !host.startsWith('*.')) || host.slice(2).includes('*')) {
      throw new Error(`unsupported URL pattern host: ${host}`);
    }
    return {scheme, host, path: wildcardRegexp(remainder.slice(pathStart))};
  }

  function normalizedURL(url) {
    const hash = url.indexOf('#');
    return hash === -1 ? url : url.slice(0, hash);
  }

  function matchesURLPattern(url, pattern) {
    const parsed = parseURLPattern(pattern);
    let candidate;
    try {
      candidate = new URL(normalizedURL(url));
    } catch {
      return false;
    }
    const scheme = candidate.protocol.slice(0, -1);
    if (parsed.scheme === '*' ? scheme !== 'http' && scheme !== 'https' : scheme !== parsed.scheme) return false;

    const host = candidate.host.toLowerCase();
    let hostMatches;
    if (parsed.host === '*') {
      hostMatches = true;
    } else if (parsed.host.startsWith('*.')) {
      const suffix = parsed.host.slice(2);
      hostMatches = host === suffix || host.endsWith(`.${suffix}`);
    } else {
      hostMatches = host === parsed.host;
    }
    return hostMatches && parsed.path.test(`${candidate.pathname}${candidate.search}`);
  }

  function matchesAny(url, patterns) {
    return patterns.some((pattern) => matchesURLPattern(url, pattern));
  }

  // Chrome match patterns for chrome.scripting: one per pattern, host-level so
  // the content script can apply the precise match itself. Chrome's `*.host`
  // already covers the apex.
  function chromeMatchPatterns(patterns) {
    const out = new Set();
    for (const pattern of patterns) {
      const parsed = parseURLPattern(pattern);
      const scheme = parsed.scheme === '*' ? '*' : parsed.scheme;
      out.add(`${scheme}://${parsed.host}/*`);
    }
    return [...out];
  }

  globalThis.xw.urlPattern = {parseURLPattern, normalizedURL, matchesURLPattern, matchesAny, chromeMatchPatterns};
})();

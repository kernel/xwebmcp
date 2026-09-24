# domains/

One directory per website, keyed by registrable domain (no scheme, port, or `www`).

```
domains/
  delta.com/
    README.md           # optional but encouraged
    search_flights.js   # one tool per file, named after the tool
    login.js
```

## Per-domain README template

```markdown
# delta.com

Tools for Delta Air Lines (https://www.delta.com).

| tool            | file              | status  | notes                          |
|-----------------|-------------------|---------|--------------------------------|
| search_flights  | search_flights.js | verified| round trips return outbound only |

## Site quirks
- Results render client-side; wait on the results container, not a fixed sleep.
- Aggressive 429 throttling; space out repeated invocations.

## Sessions
- QA browser session: <id> (24h timeout)
- Source: this repo is canonical; sessions expire but files do not.
```

Keep tool files self-contained (single expression, no imports) so they can be piped
straight into `webmcp.addCustomTools`.

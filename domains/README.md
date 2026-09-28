# domains/

One directory per website, keyed by registrable domain (no scheme, port, or `www`),
with one tool per file and a `README.md` per domain.

```
domains/
  delta.com/
    README.md           # status table, known limitations, site quirks, QA summary
    search_flights.js   # one tool per file, named after the tool
    login.js
```

The rules for directory names, tool names, URL patterns, `registry.json` entries, and
what a per-domain README must contain are in [`../spec/repository.md`](../spec/repository.md).
Run `node scripts/validate-registry.mjs` from the repository root to check a change
against them.

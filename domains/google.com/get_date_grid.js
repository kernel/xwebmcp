(() => {
  const nullable = { type: ["string", "null"], maxLength: 300 };
  return [{
    kind: "page",
    match: { url_patterns: ["https://www.google.com/travel/flights", "https://www.google.com/travel/flights?*", "https://www.google.com/travel/flights/*"] },
    tool: {
      name: "get_date_grid",
      description: "Explore alternative dates in the English Google Flights round-trip search currently loaded. Requires two resolved endpoints and a fully loaded search; reload after in-place search changes. Opens the Date grid dialog if necessary and reads at most 49 loaded cells: displayed departure/return date text, price text, price level and selected state. Never clicks a date cell, OK, a fare, tracking or booking controls; leaves the dialog open without applying dates. If another dialog is open, close it yourself first. Prices reflect the page's route, travelers, cabin, currency and filters; labels may omit the year, so do not infer ISO dates. No account needed. One-way price graphs and scrolling the grid are not supported.",
      inputSchema: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 49, default: 49 } } },
      outputSchema: {
        type: "object", additionalProperties: false,
        required: ["status", "message", "display_currency", "cells", "has_more", "dates_applied"],
        properties: {
          status: { type: "string", enum: ["ok", "invalid_input", "wrong_page", "unsupported_language", "not_ready", "unsupported_trip", "dialog_open", "blocked", "consent_required", "rate_limited", "site_changed", "timeout", "canceled"] },
          message: { type: "string" }, display_currency: nullable,
          cells: {
            type: "array", maxItems: 49,
            items: { type: "object", additionalProperties: false, required: ["departure_date_text", "return_date_text", "price_text", "price_level", "selected"], properties: {
              departure_date_text: { type: "string", minLength: 1, maxLength: 100 }, return_date_text: { type: "string", minLength: 1, maxLength: 100 },
              price_text: { type: "string", minLength: 1, maxLength: 100 }, price_level: { type: ["string", "null"], enum: ["cheapest", "low", "high", null] }, selected: { type: "boolean" }
            } }
          }, has_more: { type: "boolean" }, dates_applied: { const: false }
        }
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    execute: async (input, context = {}) => {
      const result = { status: "wrong_page", message: "", display_currency: null, cells: [], has_more: false, dates_applied: false };
      const fail = (status, message) => ({ ...result, status, message });
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "limit") || input.limit === null || !Number.isInteger(input.limit ?? 49) || (input.limit ?? 49) < 1 || (input.limit ?? 49) > 49) return fail("invalid_input", "limit must be an integer from 1 to 49; no other fields are accepted.");
      if (context.signal?.aborted) return fail("canceled", "Read canceled before opening any dialog.");
      if (location.hostname === "consent.google.com") return fail("consent_required", "Handle consent yourself; no preference is changed.");
      if (location.pathname.startsWith("/sorry")) return fail("blocked", "Google served an automated-traffic challenge.");
      if (location.hostname !== "www.google.com" || location.pathname !== "/travel/flights/search") return fail("wrong_page", "Run search_flights or open a round-trip Flights search first.");
      if (!/^en(?:-|$)/i.test(document.documentElement.lang)) return fail("unsupported_language", "An English Flights interface is required.");
      const visible = e => e.getClientRects().length > 0;
      const text = e => (e?.textContent || "").replace(/\s+/g, " ").trim();
      const body = document.body?.innerText || "";
      if (/too many requests|rate limit|try again later/i.test(body)) return fail("rate_limited", "Google reports a temporary request limit; do not retry automatically.");
      const ready = () => {
        const navigation = performance.getEntriesByType("navigation")[0];
        const from = [...document.querySelectorAll('input[aria-label^="Where from?"]')].filter(visible);
        const to = [...document.querySelectorAll('input[aria-label^="Where to?"]')].filter(visible);
        if (window.__xwebmcpGoogleDateGridDirty || !navigation || new URL(navigation.name).search !== location.search || [...from, ...to].some(e => e.value !== e.getAttribute("value"))) {
          window.__xwebmcpGoogleDateGridDirty = true;
          return false;
        }
        if (from.length !== 1 || to.length !== 1 || [...from, ...to].some(e => !e.value.trim() || e.getAttribute("aria-expanded") === "true")) return false;
        return ![...document.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(e => visible(e) && (e.getAttribute("aria-hidden") !== "true" || e.parentElement?.getAttribute("aria-hidden") !== "true"));
      };
      if (!ready()) return fail("not_ready", "Wait for two resolved search endpoints and prices; reload after changing the search before opening the grid.");
      const dialogs = () => [...document.querySelectorAll('[role="dialog"]')].filter(visible);
      const insights = () => dialogs().find(e => e.getAttribute("aria-label") === "Price insights");
      if (dialogs().some(e => e !== insights())) return fail("dialog_open", "Close the other dialog before reading the date grid.");
      if (!insights()) {
        const button = [...document.querySelectorAll("button")].find(e => visible(e) && text(e) === "Date grid");
        if (!button) return fail("not_ready", "The search has no loaded Date grid control; wait for a round-trip search to finish.");
        button.click();
      }
      const start = Date.now();
      while (Date.now() - start < 12000) {
        if (context.signal?.aborted) return fail("canceled", "Read canceled; the dialog may remain open, but no dates were applied.");
        if (!ready()) return fail("not_ready", "The search changed or prices are pending; reload before reading the grid. No dates were applied.");
        const dialog = insights();
        const grid = dialog?.querySelector('[data-ow="false"]');
        if (dialog?.querySelector('[data-ow="true"]')) return fail("unsupported_trip", "Only the round-trip date grid is supported; no dates were applied.");
        const dates = dialog && [...dialog.querySelectorAll('[role="tab"]')].find(e => visible(e) && text(e) === "Dates");
        if (dates && dates.getAttribute("aria-selected") !== "true") return fail("dialog_open", "Switch the Price insights dialog to Dates yourself; no tab is changed by the tool.");
        const nodes = grid && [...grid.querySelectorAll('[data-row][data-col][role="button"][aria-label]')].filter(visible);
        if (nodes?.length) {
          const date = "((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \\d{1,2}(?:, \\d{4})?)";
          const pattern = new RegExp(`^(.+?), (?:(cheapest|low|high) price, )?${date} to ${date}(, selected)?$`);
          const cells = nodes.slice(0, input.limit ?? 49).map(e => {
            const label = (e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
            const match = label.match(pattern);
            if (!match || !/\d/.test(match[1])) return null;
            return { departure_date_text: match[3], return_date_text: match[4], price_text: match[1].slice(0, 100), price_level: match[2] || null, selected: !!match[5] };
          });
          if (cells.some(c => !c)) return fail("site_changed", "A loaded cell lacks recognizable date and price labels; no partial result is returned.");
          const currency = [...document.querySelectorAll('button, [role="button"][aria-label]')].find(e => visible(e) && /^Currency [A-Z]{3}$/.test(e.getAttribute("aria-label") || ""));
          return { ...result, status: "ok", message: "Displayed date labels only (year may be omitted). Prices are indicative for the current search. Dialog left open; no date cell selected or applied.", display_currency: currency?.getAttribute("aria-label").slice(-3) || null, cells, has_more: nodes.length > cells.length };
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      return fail("timeout", "The round-trip date grid did not load in 12 seconds; no dates were applied.");
    }
  }];
})()

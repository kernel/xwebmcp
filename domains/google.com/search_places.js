[{
  kind: "page",
  match: { url_patterns: ["https://www.google.com/maps/*"] },
  tool: {
    name: "search_places",
    description: "Search Google Maps for places from a Maps page and return the first results Maps loads: name, category, street address, rating, review count, price range, opening-status text, coordinates and a place_url. Put the location in the query ('coffee shops in Cincinnati OH'); without one Maps biases results toward its current map view. Works in the current Maps tab by using Maps' own search box, so the tab must already be on a https://www.google.com/maps page with an English interface (open https://www.google.com/maps?hl=en first). It does not scroll or page: at most 20 results, the ones Maps shows for one query, meant for answering a user's question, not for collecting listings in bulk. A query that names one specific place can open that place directly and return status 'single_place' with its place_url; use get_place for its details. Pass a place_url to get_place to read one place. The Maps tab is left on the search results. Sponsored placements are not identified. Signed in, Google may record the search in the account's Maps or search history as it does for any manual search. Read-only.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200, description: "What to find and where, as typed into Maps." },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10, description: "Maximum places to return, in Maps' order." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "query", "search_url", "loaded", "returned", "places", "warnings", "retrieved_at"],
          properties: {
            status: { const: "ok" },
            query: { type: "string" },
            search_url: { type: "string", format: "uri" },
            loaded: { type: "integer", minimum: 0, description: "Result cards Maps had loaded; returned is capped by limit." },
            returned: { type: "integer", minimum: 1 },
            places: {
              type: "array", minItems: 1, maxItems: 20,
              items: {
                type: "object", additionalProperties: false,
                required: ["name", "feature_id", "place_id", "place_url", "latitude", "longitude", "category", "address", "rating", "review_count", "price_range", "open_status_text"],
                properties: {
                  name: { type: "string", minLength: 1 },
                  feature_id: { type: "string", pattern: "^0x[0-9a-f]+:0x[0-9a-f]+$", description: "Maps' stable id for the place." },
                  place_id: { type: ["string", "null"], description: "Google Place ID (ChIJ...) when the card carries it." },
                  place_url: { type: "string", format: "uri", description: "Canonical https://www.google.com/maps/place/ URL for this place, without session or viewport state. Pass it to get_place." },
                  latitude: { type: ["number", "null"] }, longitude: { type: ["number", "null"] },
                  category: { type: ["string", "null"] },
                  address: { type: ["string", "null"], description: "Street address as the result card shows it, often without city or postal code." },
                  rating: { type: ["number", "null"] }, review_count: { type: ["integer", "null"] },
                  price_range: { type: ["string", "null"], description: "Google's label, for example '$10 to $20'." },
                  open_status_text: { type: ["string", "null"], description: "As shown, for example 'Open · Closes 9 PM'; relative to when the page was read." }
                }
              }
            },
            warnings: { type: "array", items: { type: "string" } },
            retrieved_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "query", "name", "feature_id", "place_url", "retrieved_at"],
          properties: {
            status: { const: "single_place" }, query: { type: "string" },
            name: { type: "string" }, feature_id: { type: "string" }, place_url: { type: "string", format: "uri" }, retrieved_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "query", "message"],
          properties: { status: { const: "no_results" }, query: { type: "string" }, message: { type: "string" } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "unsupported_language", "timeout", "site_changed"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.google.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "query" && k !== "limit")) return fail("invalid_input", "Provide query (1-200 characters) and optionally limit (1-20).");
    const query = typeof input.query === "string" ? input.query.replace(/\s+/g, " ").trim() : "";
    const limit = input.limit === undefined ? 10 : input.limit;
    if (!query || query.length > 200 || /[\u0000-\u001f\u007f]/.test(input.query)) return fail("invalid_input", "query must be 1-200 characters of text.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return fail("invalid_input", "limit must be an integer from 1 to 20.");
    if (location.origin !== ORIGIN || !location.pathname.startsWith("/maps")) return fail("wrong_page", "Run this on a https://www.google.com/maps page.");
    if (!/^en(-|$)/i.test(document.documentElement.lang)) return fail("unsupported_language", "The Maps interface is not English. Open https://www.google.com/maps?hl=en and retry.");

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const visible = e => e.getClientRects().length > 0;
    const text = e => (e?.innerText || "").replace(/\s+/g, " ").trim();
    const fidOf = href => (/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i.exec(href) || [])[1] || null;
    const kindOf = () => location.pathname.split("/")[2] || "";
    const rawSlug = () => location.pathname.split("/")[3] || "";
    const safeSlug = seg => (/^[^/?#@][^/?#]{0,299}$/.test(seg) ? seg : "x");
    const slugOf = () => { try { return decodeURIComponent(rawSlug().replace(/\+/g, " ")).toLowerCase(); } catch (error) { return ""; } };
    const feedAnchors = () => {
      const feed = [...document.querySelectorAll('div[role="feed"]')].find(visible);
      return feed ? [...feed.querySelectorAll("a.hfpxzc")] : [];
    };
    const firstFid = () => { const a = feedAnchors()[0]; return a ? fidOf(a.getAttribute("href") || "") : null; };
    const paneOf = () => [...document.querySelectorAll('[data-item-id="address"]')].find(visible)?.closest('[role="main"]') || null;

    const box = [...document.querySelectorAll('input[name="q"]')].find(visible);
    const button = [...document.querySelectorAll('button[aria-label="Search"]')].find(visible);
    if (!box || !button) return fail("wrong_page", "No Maps search box on this page; open https://www.google.com/maps (not a directions or Street View page).");

    const want = query.toLowerCase();
    const before = { kind: kindOf(), slug: slugOf(), first: firstFid(), fid: fidOf(location.href) };
    box.focus();
    box.value = query;
    box.dispatchEvent(new Event("input", { bubbles: true }));
    button.click();

    const started = Date.now();
    let count = -1, countSince = 0;
    for (;;) {
      await sleep(250);
      const elapsed = Date.now() - started;
      if (elapsed > 25000) return fail("timeout", "Google Maps showed neither results nor a no-results message within 25 seconds.");
      if (kindOf() === "place" && paneOf()) {
        if (fidOf(location.href) !== before.fid || elapsed > 2500) {
          const fid = fidOf(location.href);
          const pane = paneOf();
          const name = text([...pane.querySelectorAll("h1")].find(h => text(h) && !/^Sponsored\b/.test(text(h)))) || (pane.getAttribute("aria-label") || "").trim();
          if (!fid || !name) return fail("site_changed", "Maps opened a place but its name or id could not be read.");
          return { status: "single_place", query, name, feature_id: fid, place_url: `${ORIGIN}/maps/place/${safeSlug(rawSlug())}/data=!4m2!3m1!1s${fid}`, retrieved_at: new Date().toISOString() };
        }
      } else if (kindOf() === "search") {
        const main = [...document.querySelectorAll('[role="main"]')].filter(visible).map(text).find(t => /Google Maps can.t find/i.test(t));
        if (main && main.toLowerCase().includes(want) && elapsed > 1500) return { status: "no_results", query, message: `Google Maps found no places for "${query}".` };
        const cards = feedAnchors();
        if (cards.length !== count) { count = cards.length; countSince = elapsed; }
        const fresh = slugOf() === want
          ? (before.kind === "search" && before.slug === want) || firstFid() !== before.first || elapsed > 4000
          : elapsed > 8000 && (before.kind !== "search" || slugOf() !== before.slug);
        if (cards.length && fresh && elapsed - countSince >= 1000) break;
      }
    }

    const anchors = feedAnchors();
    const STATUS = /^(Open|Closed|Closes|Opens|Temporarily closed|Permanently closed)\b/;
    const places = [];
    let skipped = 0;
    for (const a of anchors) {
      if (places.length === limit) break;
      const href = a.getAttribute("href") || "";
      let url;
      try { url = new URL(href, ORIGIN); } catch (error) { skipped++; continue; }
      const fid = fidOf(href);
      const name = (a.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      const slug = url.pathname.split("/")[3] || "";
      if (url.origin !== ORIGIN || !url.pathname.startsWith("/maps/place/") || !fid || !name || !/^[^/?#]{1,300}$/.test(slug)) { skipped++; continue; }
      const card = a.parentElement;
      const lines = (card.innerText || "").split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
      const labels = [...card.querySelectorAll('[role="img"][aria-label]')].map(e => e.getAttribute("aria-label"));
      const ratingMatch = labels.map(l => /^(\d(?:\.\d)?) stars? ([\d,]+) Reviews?$/i.exec(l)).find(Boolean);
      const statusLine = lines.find(l => STATUS.test(l));
      const detailLine = lines.slice(1).find(l => /[·⋅]/.test(l) && !STATUS.test(l) && !/^\d(\.\d)?\(/.test(l) && !/^["“]/.test(l));
      const detail = detailLine ? detailLine.split(/\s*[·⋅]\s*/).map(s => s.trim()).filter(Boolean) : [];
      const coords = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(href);
      places.push({
        name, feature_id: fid,
        place_id: (/!19s(ChIJ[A-Za-z0-9_-]+)/.exec(href) || [])[1] || null,
        place_url: `${ORIGIN}/maps/place/${slug}/data=!4m2!3m1!1s${fid}`,
        latitude: coords ? Number(coords[1]) : null, longitude: coords ? Number(coords[2]) : null,
        category: detail[0] || null,
        address: detail.length > 1 ? detail[detail.length - 1].slice(0, 200) : null,
        rating: ratingMatch ? Number(ratingMatch[1]) : null,
        review_count: ratingMatch ? Number(ratingMatch[2].replace(/,/g, "")) : null,
        price_range: labels.find(l => /^\$/.test(l))?.slice(0, 40) || null,
        open_status_text: statusLine ? statusLine.replace(/\s[·⋅]\s\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}.*$/, "").slice(0, 80) : null
      });
    }
    if (!places.length) return fail("site_changed", "Maps showed result cards but none could be read as places.");
    const warnings = skipped ? [`Skipped ${skipped} result card(s) that could not be read as places.`] : [];
    return {
      status: "ok", query, search_url: `${ORIGIN}/maps/search/${safeSlug(rawSlug())}/`,
      loaded: anchors.length, returned: places.length, places, warnings, retrieved_at: new Date().toISOString()
    };
  }
}]

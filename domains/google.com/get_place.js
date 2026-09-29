[{
  kind: "page",
  match: { url_patterns: ["https://www.google.com/maps/*"] },
  tool: {
    name: "get_place",
    description: "Read the details Google Maps shows for one place: name, category, rating and review count, address, phone number, website, Plus Code, coordinates, the open-status line and, when the place pane lists them, the weekly opening hours (some places show only a collapsed hours row, which the tool does not open, so hours is empty and open_status_text still gives today's status). Runs in the current Maps tab, which must be on a https://www.google.com/maps page with an English interface. With no input it reads the place already open in the tab. With place_url (from search_places) it opens that place first by selecting its card in the search results the tab is showing; a place that is neither open nor in those results returns not_open, and you then open place_url in the tab yourself and call again. Never navigates the tab. Business details are whatever the business or Google publishes and can be out of date; open_status_text and hours are relative to when the page was read. Reviews, photos, popular times, menus, prices and sponsored panels are not returned. Signed in, Google may record the place view in the account's Maps history as it does for any manual visit. Read-only.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        place_url: { type: "string", maxLength: 1000, description: "A place_url from search_places (https://www.google.com/maps/place/... containing the place's !1s feature id). Omit to read the place currently open." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "name", "feature_id", "place_id", "place_url", "latitude", "longitude", "category", "rating", "review_count", "address", "phone", "website_url", "plus_code", "open_status_text", "hours", "retrieved_at"],
          properties: {
            status: { const: "ok" },
            name: { type: "string", minLength: 1 },
            feature_id: { type: "string", pattern: "^0x[0-9a-f]+:0x[0-9a-f]+$" },
            place_id: { type: ["string", "null"], description: "Google Place ID when the open place's URL carries it; otherwise null (search_places returns it from the result card)." },
            place_url: { type: "string", format: "uri", description: "Canonical https://www.google.com/maps/place/ URL without session or viewport state." },
            latitude: { type: ["number", "null"] }, longitude: { type: ["number", "null"] },
            category: { type: ["string", "null"] },
            rating: { type: ["number", "null"] }, review_count: { type: ["integer", "null"] },
            address: { type: ["string", "null"] },
            phone: { type: ["string", "null"], description: "As Maps displays it." },
            website_url: { type: ["string", "null"], description: "The business's own website link; null when none, or when Maps only offers a Google-hosted link." },
            plus_code: { type: ["string", "null"] },
            open_status_text: { type: ["string", "null"], description: "For example 'Open · Closes 9 PM' or 'Permanently closed'." },
            hours: {
              type: "array", maxItems: 7, description: "Weekly hours in the order Maps lists them (starting with today); empty when the pane lists none.",
              items: { type: "object", additionalProperties: false, required: ["day", "hours"], properties: { day: { type: "string" }, hours: { type: "string", description: "As displayed, for example '11 AM–10 PM', '8–11 AM, 1–5 PM' or 'Closed'." } } }
            },
            retrieved_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "unsupported_language", "not_open", "timeout", "site_changed"] },
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
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "place_url")) return fail("invalid_input", "Provide only place_url, or nothing to read the open place.");
    const fidOf = href => (/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i.exec(href) || [])[1] || null;
    let wanted = null;
    if (input.place_url !== undefined) {
      let url;
      try { url = new URL(input.place_url); } catch (error) { url = null; }
      wanted = url && url.origin === ORIGIN && url.pathname.startsWith("/maps/place/") ? fidOf(url.pathname) : null;
      if (typeof input.place_url !== "string" || input.place_url.length > 1000 || !wanted) return fail("invalid_input", "place_url must be a https://www.google.com/maps/place/ URL from search_places.");
    }
    if (location.origin !== ORIGIN || !location.pathname.startsWith("/maps")) return fail("wrong_page", "Run this on a https://www.google.com/maps page.");
    if (!/^en(-|$)/i.test(document.documentElement.lang)) return fail("unsupported_language", "The Maps interface is not English. Open https://www.google.com/maps?hl=en and retry.");

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const visible = e => e.getClientRects().length > 0;
    const text = e => (e?.innerText || "").replace(/\s+/g, " ").trim();
    const currentFid = () => (location.pathname.startsWith("/maps/place/") ? fidOf(location.pathname) : null);
    const safeSlug = seg => (/^[^/?#@][^/?#]{0,299}$/.test(seg) ? seg : "x");
    const paneOf = () => [...document.querySelectorAll('[data-item-id="address"]')].find(visible)?.closest('[role="main"]') || null;

    const signature = () => {
      const pane = paneOf();
      if (!pane) return null;
      const address = (pane.querySelector('[data-item-id="address"]')?.getAttribute("aria-label") || "").replace(/^Address:\s*/, "");
      return {
        name: (pane.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(), dataFid: pane.querySelector("[data-feature-id]")?.getAttribute("data-feature-id") || null, street: address.split(",")[0].trim(),
        rows: `${pane.querySelectorAll("[data-item-id]").length}:${pane.querySelectorAll("table tr").length}`
      };
    };
    // Maps updates the URL and the pane at slightly different moments, so read only once both agree and stay unchanged.
    const settle = async accept => {
      const started = Date.now();
      let previous = null;
      for (;;) {
        const sig = signature();
        const key = sig && currentFid() && accept(sig) ? JSON.stringify([currentFid(), sig]) : null;
        if (key && key === previous) return true;
        previous = key;
        if (Date.now() - started > 15000) return false;
        await sleep(key ? 600 : 250);
      }
    };

    if (wanted && currentFid() !== wanted) {
      const card = [...document.querySelectorAll('div[role="feed"] a.hfpxzc')].find(a => fidOf(a.getAttribute("href") || "") === wanted);
      if (!card) return fail("not_open", "That place is not open in this tab and is not in the search results the tab is showing. Open place_url in the tab, then call get_place again.");
      const cardName = (card.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().toLowerCase();
      const previous = signature();
      card.click();
      const opened = await settle(sig => {
        const name = sig.name.toLowerCase();
        return (name === cardName || name.startsWith(cardName) || cardName.startsWith(name)) && currentFid() === wanted && (!sig.dataFid || sig.dataFid === wanted)
          && (!previous || previous.name.toLowerCase() !== name || previous.street !== sig.street);
      });
      if (!opened) return fail("timeout", "Maps did not open the place within 15 seconds.");
    } else if (!currentFid()) {
      return fail("not_open", "No place is open in this tab. Search with search_places and pass a place_url, or open a place in the tab.");
    } else if (!await settle(sig => !sig.dataFid || sig.dataFid === currentFid())) {
      return fail("timeout", "The open place did not finish loading within 15 seconds.");
    }

    const fid = currentFid();
    const pane = paneOf();
    const name = text([...pane.querySelectorAll("h1")].find(h => text(h) && !/^Sponsored\b/.test(text(h)))) || (pane.getAttribute("aria-label") || "").trim();
    if (!fid || !name) return fail("site_changed", "The open place's name or id could not be read.");
    const labelOf = (selector, prefix) => {
      const value = (pane.querySelector(selector)?.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      return value.startsWith(prefix) ? value.slice(prefix.length).trim() || null : null;
    };
    const ratingMatch = [...pane.querySelectorAll('[role="img"][aria-label]')].map(e => /^(\d(?:\.\d)?) stars? ([\d,]+) Reviews?$/i.exec(e.getAttribute("aria-label"))).find(Boolean);
    const coords = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(location.pathname);
    const website = pane.querySelector('a[data-item-id="authority"]')?.getAttribute("href") || "";
    let websiteUrl = null;
    try {
      const parsed = new URL(website);
      if (/^https?:$/.test(parsed.protocol) && !/(^|\.)google\.[a-z.]+$/.test(parsed.hostname) && website.length <= 500) websiteUrl = parsed.href;
    } catch (error) { websiteUrl = null; }

    const DAYS = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/;
    const hours = [];
    for (const row of pane.querySelectorAll("table tr")) {
      const cells = [...row.children];
      if (!cells.length || !DAYS.test(text(cells[0]))) continue;
      const ranges = cells[1] ? [...cells[1].querySelectorAll("li")].map(text).filter(Boolean) : [];
      const value = (ranges.length ? ranges : [text(cells[1])]).filter(Boolean).join(", ");
      if (value && hours.length < 7) hours.push({ day: text(cells[0]), hours: value.slice(0, 120) });
    }
    const lines = (pane.innerText || "").split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    const firstDay = lines.findIndex(l => DAYS.test(l));
    const statusLine = (firstDay < 0 ? lines : lines.slice(0, firstDay)).find(l => l.length < 80 && /^(Open|Closed|Closes|Opens|Temporarily closed|Permanently closed)\b/.test(l));
    return {
      status: "ok", name, feature_id: fid,
      place_id: (/!19s(ChIJ[A-Za-z0-9_-]+)/.exec(location.pathname) || [])[1] || null,
      place_url: `${ORIGIN}/maps/place/${safeSlug(location.pathname.split("/")[3] || "")}/data=!4m2!3m1!1s${fid}`,
      latitude: coords ? Number(coords[1]) : null, longitude: coords ? Number(coords[2]) : null,
      category: text(pane.querySelector("button.DkEaL")).slice(0, 80) || null,
      rating: ratingMatch ? Number(ratingMatch[1]) : null,
      review_count: ratingMatch ? Number(ratingMatch[2].replace(/,/g, "")) : null,
      address: labelOf('[data-item-id="address"]', "Address:")?.slice(0, 250) || null,
      phone: labelOf('button[data-item-id^="phone:tel:"]', "Phone:")?.slice(0, 40) || null,
      website_url: websiteUrl,
      plus_code: labelOf('[data-item-id="oloc"]', "Plus code:")?.slice(0, 120) || null,
      open_status_text: statusLine ? statusLine.replace(/\s[·⋅]\s\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}.*$/, "") : null,
      hours, retrieved_at: new Date().toISOString()
    };
  }
}]

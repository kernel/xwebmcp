[{
  kind: "page",
  match: { url_patterns: ["https://www.ebay.com/*"] },
  tool: {
    name: "get_seller_profile",
    title: "Get eBay seller feedback summary",
    description: "Read an eBay seller's public feedback profile by username (the seller.username from get_listing or search): feedback score, positive feedback percentage over the last 12 months, member-since text, whether eBay marks the seller Top-rated, the counts of positive, neutral and negative feedback over the last 1, 6 and 12 months, and the detailed seller ratings (accurate description, shipping cost, shipping speed, communication) with their average and number of ratings. Read-only: it fetches the public feedback page from the current document and never contacts the seller or changes anything. Individual buyer comments, buyer names and purchases shown on that page are deliberately not returned. If eBay shows its error state for the username, the result is profile_unavailable: the username does not exist or the page failed to load, and the tool cannot tell which. eBay sometimes answers with its error page; the tool retries up to twice (after 4 and 8 seconds) and then returns blocked; space calls by about ten seconds. If eBay redirects the request, one additional fetch follows the same-host redirect chain, which can issue multiple GETs; a redirect to another host is refused without being sent; a redirect to a verification page is reported as challenge: a person has to complete it in the browser and the tool never tries.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["seller_username"],
      properties: {
        seller_username: { type: "string", pattern: "^(?=.*[A-Za-z0-9])[A-Za-z0-9._@*-]{2,64}$", description: "eBay username of the seller, without spaces, as shown on listings and in feedback URLs; it must contain a letter or digit." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "username", "profile_url", "feedback_score", "positive_percent_12_months", "member_since_text", "member_location_text", "top_rated", "feedback_counts", "detailed_ratings"],
          properties: {
            status: { const: "ok" },
            username: { type: "string" },
            profile_url: { type: "string", description: "Canonical https://www.ebay.com/fdbk/feedback_profile/<username> link." },
            feedback_score: { type: ["integer", "null"], description: "The number in brackets beside the username." },
            positive_percent_12_months: { type: ["number", "null"] },
            member_since_text: { type: ["string", "null"], description: "As displayed, for example 'Apr-06-26'." },
            member_location_text: { type: ["string", "null"], description: "Country shown beside member since." },
            top_rated: { type: "boolean", description: "True when the page carries eBay's Top-rated seller line; false only means the line is absent." },
            feedback_counts: {
              type: "object", additionalProperties: false, required: ["positive", "neutral", "negative"],
              properties: {
                positive: { type: "object", additionalProperties: false, required: ["one_month", "six_months", "twelve_months"], properties: { one_month: { type: ["integer", "null"] }, six_months: { type: ["integer", "null"] }, twelve_months: { type: ["integer", "null"] } } },
                neutral: { type: "object", additionalProperties: false, required: ["one_month", "six_months", "twelve_months"], properties: { one_month: { type: ["integer", "null"] }, six_months: { type: ["integer", "null"] }, twelve_months: { type: ["integer", "null"] } } },
                negative: { type: "object", additionalProperties: false, required: ["one_month", "six_months", "twelve_months"], properties: { one_month: { type: ["integer", "null"] }, six_months: { type: ["integer", "null"] }, twelve_months: { type: ["integer", "null"] } } }
              }
            },
            detailed_ratings: {
              type: "array", maxItems: 6,
              items: {
                type: "object", additionalProperties: false, required: ["name", "average", "rating_count"],
                properties: { name: { type: "string" }, average: { type: ["number", "null"], description: "Average out of 5 over the last 12 months." }, rating_count: { type: ["integer", "null"] } }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "profile_unavailable", "blocked", "challenge", "rate_limited", "redirected", "request_failed", "site_error", "site_changed", "canceled"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input, { signal } = {}) => {
    const ORIGIN = "https://www.ebay.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const clean = s => typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object.");
    const extra = Object.keys(input).find(key => key !== "seller_username");
    if (extra !== undefined) return fail("invalid_input", `Unrecognized input field "${extra.slice(0, 80)}".`);
    if (typeof input.seller_username !== "string" || !/^(?=.*[A-Za-z0-9])[A-Za-z0-9._@*-]{2,64}$/.test(input.seller_username)) return fail("invalid_input", "seller_username must be an eBay username of 2 to 64 letters, digits or . _ - @ * characters, with at least one letter or digit.");
    const username = input.seller_username;
    if (signal?.aborted) return fail("canceled", "The read was canceled.");
    if (location.origin !== ORIGIN) return fail("wrong_page", "Open a https://www.ebay.com page in this tab, then call again. Nothing was requested.");

    if (/^\/splashui\//.test(location.pathname)) return fail("challenge", "This tab is on eBay's verification page. Nothing was requested; the tool never solves challenges.");

    const path = `/fdbk/feedback_profile/${encodeURIComponent(username)}`;
    let html = null;
    for (let attempt = 1; attempt <= 3 && html === null; attempt++) {
      if (attempt > 1) await new Promise(resolve => setTimeout(resolve, 4000 * (attempt - 1)));
      if (signal?.aborted) return fail("canceled", "The read was canceled.");
      let response;
      try { response = await fetch(path, { credentials: "include", redirect: "manual", ...(signal ? { signal } : {}) }); }
      catch { return signal?.aborted ? fail("canceled", "The read was canceled.") : fail("request_failed", "The request to eBay failed before a response arrived. Nothing was intentionally changed."); }
      if (signal?.aborted) return fail("canceled", "The read was canceled.");
      if (response.type === "opaqueredirect") {
        // A redirect is not followed automatically; the request is repeated once with mode "same-origin" (a redirect to another host is refused without being sent) to recognize a verification page.
        let followed = null;
        try { followed = await fetch(path, { credentials: "include", mode: "same-origin", ...(signal ? { signal } : {}) }); } catch { /* the redirect may lead to another host */ }
        if (signal?.aborted) return fail("canceled", "The read was canceled.");
        let landed = "";
        try { if (followed) landed = new URL(followed.url).pathname; } catch { return fail("redirected", "eBay's redirect destination could not be read. Nothing was intentionally changed."); }
        if (/^\/splashui\//.test(landed)) return fail("challenge", "eBay redirected to a verification (CAPTCHA) page instead of returning the feedback profile. A person has to complete it in this browser; the tool never tries to solve it, and repeated calls make it more likely.");
        if (followed && followed.status === 403) continue;
        return fail("redirected", "eBay redirected the feedback request instead of returning the page (it may be a sign-in or regional page). Open the profile in the browser to see it; this tool does not follow or solve it.");
      }
      if (response.status === 429) return fail("rate_limited", "eBay rate-limited the feedback request; wait a few minutes before retrying.");
      let body;
      try { body = await response.text(); }
      catch { return signal?.aborted ? fail("canceled", "The read was canceled.") : fail("request_failed", "The response body could not be read."); }
      if (signal?.aborted) return fail("canceled", "The read was canceled.");
      if (/<title>\s*(?:Security Measure|Pardon Our Interruption)\s*\|\s*eBay/i.test(body.slice(0, 4000))) return fail("challenge", "eBay returned a verification page. The tool never solves challenges.");
      if (response.status === 403 || /<title>\s*Error Page \| eBay/i.test(body.slice(0, 4000))) continue;
      if (response.status >= 400) return fail("site_error", `eBay answered HTTP ${response.status} for the feedback profile.`);
      html = body;
    }
    if (html === null) return fail("blocked", "eBay answered its error page (HTTP 403) on three attempts. This happens intermittently and after bursts of requests; wait a minute or more before retrying, and space calls by about ten seconds. The tool does not try to get past it.");

    const doc = new DOMParser().parseFromString(html, "text/html");
    const text = el => {
      let out = "";
      const walk = node => {
        if (node.nodeType === 3) out += node.textContent;
        else if (node.nodeType === 1 && !node.classList.contains("clipped")) for (const child of node.childNodes) walk(child);
      };
      if (el) walk(el);
      return clean(out);
    };
    const details = doc.querySelector("section.userDetails");
    if (!details) return fail("profile_unavailable", "eBay showed its error state instead of a feedback profile for this username. The username may not exist, or the page failed to load; retry once before concluding it does not exist.");

    const nameLink = details.querySelector(".userTopLine a");
    const name = nameLink ? text(nameLink) : "";
    const score = details.querySelector(".userTopLine p");
    const positive = /:\s*([\d.]+)%/.exec(text(details.querySelector(".positiveFeedbackText span")));
    const lines = [...details.querySelectorAll("li")].map(li => text(li));
    const member = lines.map(line => /^Member since:\s*(.+?)(?:\s+in\s+(.+))?$/i.exec(line)).find(Boolean);

    const periods = { "1 month": "one_month", "6 months": "six_months", "12 months": "twelve_months" };
    const counts = { positive: { one_month: null, six_months: null, twelve_months: null }, neutral: { one_month: null, six_months: null, twelve_months: null }, negative: { one_month: null, six_months: null, twelve_months: null } };
    let countsFound = false;
    for (const table of doc.querySelectorAll("table")) {
      const heads = [...table.querySelectorAll("thead th")].map(th => periods[text(th).toLowerCase()] || null);
      if (heads.filter(Boolean).length !== 3) continue;
      for (const row of table.querySelectorAll("tbody tr")) {
        const kind = text(row.querySelector("th")).toLowerCase();
        if (!Object.hasOwn(counts, kind)) continue;
        [...row.querySelectorAll("td")].forEach((td, i) => {
          const value = /^[\d,]+$/.test(text(td)) ? Number(text(td).replace(/,/g, "")) : null;
          if (heads[i + 1]) { counts[kind][heads[i + 1]] = value; countsFound = true; }
        });
      }
      break;
    }
    if (!countsFound || !name) return fail("site_changed", "The feedback page loaded but the username or the feedback counts were not recognized; eBay may have changed its markup. Nothing was changed.");

    const ratings = [];
    for (const item of doc.querySelectorAll(".dsrTable li")) {
      const label = text(item.querySelector("div"));
      const tip = /Average rating of ([\d.]+) out of 5 based on ([\d,]+) ratings?/i.exec(text(item.querySelector(".tooltiphelp-text")));
      const bracket = /\(([\d,]+)\)/.exec(text(item.querySelector(".number")));
      const count = tip ? tip[2] : bracket ? bracket[1] : null;
      if (label && ratings.length < 6) ratings.push({ name: label.slice(0, 60), average: tip ? Number(tip[1]) : null, rating_count: count ? Number(count.replace(/,/g, "")) : null });
    }

    return {
      status: "ok",
      username: name.slice(0, 64),
      profile_url: `${ORIGIN}/fdbk/feedback_profile/${encodeURIComponent(username)}`,
      feedback_score: score && /^[\d,]+$/.test(text(score)) ? Number(text(score).replace(/,/g, "")) : null,
      positive_percent_12_months: positive ? Number(positive[1]) : null,
      member_since_text: member ? member[1].slice(0, 40) : null,
      member_location_text: member && member[2] ? member[2].slice(0, 60) : null,
      top_rated: lines.some(line => /^Top-rated seller\b/i.test(line)),
      feedback_counts: counts,
      detailed_ratings: ratings
    };
  }
}]

[{
  kind: "page",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "get_cart",
    title: "Read the open AMC cart",
    description: "Read the AMC cart open in this tab (the order page add_tickets_to_cart or the user opened): ticket lines, food and drink lines, fees and taxes with amounts, seats, total, which step of AMC's checkout the page is on, and how many seconds remain on AMC's hold of the seats. Read-only: it presses nothing, so it neither extends nor releases the hold. Amounts are as AMC shows them before checkout; payment can still change the total. Returns no_cart when the tab is not on an AMC cart before payment, including the confirmation page of a paid order, which it never reads.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "step", "lines", "seats", "total", "expires_in_seconds", "observed_at"],
          properties: {
            status: { const: "ok" },
            step: { type: "string", enum: ["food-and-drink", "purchase"], description: "The order page's step." },
            lines: {
              type: "array", maxItems: 30,
              items: { type: "object", additionalProperties: false, required: ["section", "name", "amount"], properties: { section: { type: "string" }, name: { type: "string" }, amount: { type: ["number", "null"] } } }
            },
            seats: { type: "array", maxItems: 10, items: { type: "string" } },
            total: { type: ["number", "null"] },
            expires_in_seconds: { type: ["integer", "null"] },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "no_cart", "not_ready", "challenge"] },
            error_message: { type: "string" }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async input => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)) return fail("invalid_input", "This tool takes no inputs.");
    if (/just a moment|attention required|access denied/i.test(document.title || "")) return fail("challenge", "AMC is blocking access. This tool does not bypass the challenge.");
    const path = window.location.origin === "https://www.amctheatres.com" ? /^\/orders\/[^/]+\/(food-and-drink|purchase)\/?$/.exec(window.location.pathname) : null;
    if (!path) return fail("no_cart", "The tab is not on an AMC cart before payment. add_tickets_to_cart opens one; a paid order's pages are not read.");
    const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
    const usd = t => { const m = /^(-?)\$(\d{1,6}(?:,\d{3})*\.\d{2})$/.exec(t); return m ? Number(m[2].replace(/,/g, "")) * (m[1] ? -1 : 1) : null; };
    const panels = [...document.querySelectorAll('aside[role="region"][aria-label="Order Details"]')];
    const panel = panels.find(a => a.getClientRects().length) || panels[0];
    if (!panel && [...document.querySelectorAll("h1, h2")].some(h => text(h) === "Error 404")) return fail("no_cart", "AMC no longer has this order (it shows Error 404); the cart was released or has expired.");
    if (!panel) return fail("not_ready", "The cart page has not shown its order details yet; retry in a moment.");
    const lines = [], seats = [];
    for (const h4 of panel.querySelectorAll("h4")) {
      const list = h4.closest("ul");
      const heading = list && list.parentElement && list.parentElement.querySelector("h2");
      const amount = h4.parentElement && h4.parentElement.parentElement && h4.parentElement.parentElement.children[1];
      if (text(h4)) lines.push({ section: text(heading) || "Order", name: text(h4).slice(0, 200), amount: usd(text(amount)) });
    }
    for (const li of panel.querySelectorAll("li")) { const m = /^Seats? ([A-Z0-9, ]+)$/.exec(text(li)); if (m) seats.push(...m[1].split(/[ ,]+/).filter(Boolean)); }
    const totalLine = [...panel.querySelectorAll("p")].find(p => /^Total/i.test(text(p)));
    const left = /(\d{1,2}):(\d{2}) left/.exec(document.body.innerText || "");
    return {
      status: "ok", step: path[1], lines: lines.slice(0, 30), seats: [...new Set(seats)].slice(0, 10),
      total: totalLine ? usd(text(totalLine).replace(/^Total\s*/i, "")) : null,
      expires_in_seconds: left ? Number(left[1]) * 60 + Number(left[2]) : null, observed_at: new Date().toISOString()
    };
  }
}]

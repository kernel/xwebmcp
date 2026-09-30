[{
  kind: "page",
  match: { url_patterns: ["https://www.airbnb.com/*"] },
  tool: {
    name: "prepare_booking",
    description: "Read a preliminary Airbnb booking preview on an already-loaded public listing page with exact dates and adult guests. Requires an English page loaded with check_in, check_out, adults and currency=USD query parameters matching the input; otherwise returns wrong_page with a safe listing-page entry_url. Reads displayed price, dates, guest count and limited payment/cancellation notice without clicks, requests or navigation. This is not a final quote or reservation: taxes, full terms and availability require human review on Airbnb. Never clicks Reserve, accepts terms or opens checkout. No inquiry or booking execution is supported.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["listing_id", "checkin", "checkout", "adults"],
      properties: {
        listing_id: { type: "string", pattern: "^[1-9][0-9]{0,19}$" },
        checkin: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
        checkout: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
        adults: { type: "integer", minimum: 1, maximum: 16 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "listing_id", "handoff_url", "checkin", "checkout", "adults", "nights", "requested_currency", "displayed_price_text", "guests_text", "terms_summary", "terms_complete", "reservation_created", "execution_supported", "warnings", "observed_at"],
          properties: {
            status: { const: "prepared" },
            listing_id: { type: "string", pattern: "^[1-9][0-9]{0,19}$" },
            handoff_url: { type: "string", maxLength: 250 },
            checkin: { type: "string" }, checkout: { type: "string" },
            adults: { type: "integer", minimum: 1, maximum: 16 },
            nights: { type: "integer", minimum: 1, maximum: 365 },
            requested_currency: { const: "USD" },
            displayed_price_text: { type: "string", maxLength: 600 },
            guests_text: { type: "string", maxLength: 100 },
            terms_summary: { type: ["string", "null"], maxLength: 600 },
            terms_complete: { const: false }, reservation_created: { const: false }, execution_supported: { const: false },
            warnings: { type: "array", maxItems: 3, items: { type: "string", maxLength: 250 } },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "error_kind", "error_message", "entry_url"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "challenge", "login_required", "unavailable", "site_changed"] },
            error_message: { type: "string", maxLength: 250 },
            entry_url: { type: ["string", "null"], maxLength: 250 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async input => {
    const fail = (kind, message, entry = null) => ({ status: "error", error_kind: kind, error_message: message, entry_url: entry });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["listing_id", "checkin", "checkout", "adults"].includes(key))) return fail("invalid_input", "Provide listing_id, checkin, checkout and adults only.");
    const validDate = value => typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    const nights = (Date.parse(input.checkout) - Date.parse(input.checkin)) / 86400000;
    if (typeof input.listing_id !== "string" || !/^[1-9][0-9]{0,19}$/.test(input.listing_id) || !validDate(input.checkin) || !validDate(input.checkout) || !Number.isInteger(nights) || nights < 1 || nights > 365 || !Number.isInteger(input.adults) || input.adults < 1 || input.adults > 16) return fail("invalid_input", "Use a numeric listing_id, paired real calendar dates (1–365 nights), and 1–16 adults.");
    const entry = new URL("/rooms/" + input.listing_id, "https://www.airbnb.com");
    entry.searchParams.set("check_in", input.checkin);
    entry.searchParams.set("check_out", input.checkout);
    entry.searchParams.set("adults", String(input.adults));
    entry.searchParams.set("currency", "USD");
    const visible = element => element?.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const headings = [...document.querySelectorAll('h1, h2, h3, [role="heading"]')].filter(visible).map(heading => heading.innerText || "");
    const verificationText = (document.title || "") + " " + headings.join(" ");
    if (/captcha|access denied|robot check|security check|unusual traffic|verify (you are|you're) human|confirm you.?re human/i.test(verificationText)) return fail("challenge", "The page requires access verification; no action was taken.");
    if (/log in|sign in/i.test(document.title || "")) return fail("login_required", "A public listing page is required; no sign-in is attempted.");
    const current = new URL(location.href);
    if (current.origin !== entry.origin || current.pathname !== entry.pathname || ["check_in", "check_out", "adults", "currency"].some(key => current.searchParams.getAll(key).length !== 1 || current.searchParams.get(key) !== entry.searchParams.get(key)) || ["children", "infants", "pets"].some(key => current.searchParams.getAll(key).length > 1 || current.searchParams.has(key) && current.searchParams.get(key) !== "0")) return fail("wrong_page", "Open entry_url and let Airbnb render the exact listing, dates and adult guests, then invoke again.", entry.href);
    if (!/^en(?:-|$)/i.test(document.documentElement.lang || "")) return fail("site_changed", "Only the observed English booking preview is supported.", entry.href);
    let pageId;
    try {
      const state = JSON.parse(document.querySelector("#data-deferred-state-0")?.textContent || "null");
      const records = Array.isArray(state?.niobeClientData) ? state.niobeClientData.slice(0, 60) : [];
      const node = records.map(record => record?.[1]?.data?.node).find(value => value?.pdpPresentation);
      pageId = atob(node?.id || "");
    } catch { return fail("site_changed", "The rendered listing identity is unsupported.", entry.href); }
    if (pageId !== "DemandStayListing:" + input.listing_id) return fail("wrong_page", "The rendered listing identity differs from the requested listing.", entry.href);
    const enabled = element => visible(element) && !element.disabled && !element.matches(":disabled") && !element.closest('[aria-disabled="true"], [inert]');
    const panels = [...document.querySelectorAll('[data-testid="book-it-default"]')].filter(visible);
    if (panels.some(panel => /dates (aren't|are not|not) available|not available|unavailable|choose different dates/i.test(panel.innerText || ""))) return fail("unavailable", "The listing page says these dates are unavailable.", entry.href);
    if (panels.length !== 1) return fail("site_changed", "One visible supported booking preview is required.", entry.href);
    const panel = panels[0];
    const panelText = panel.innerText || "";
    const buttons = [...panel.querySelectorAll('button, [role="button"]')].filter(visible);
    const dates = buttons.map(button => button.getAttribute("aria-label") || "").find(label => label.startsWith("Change dates;"));
    if (dates !== "Change dates; Check-in: " + input.checkin + "; Checkout: " + input.checkout) return fail("wrong_page", "The rendered dates do not match the requested dates; no quote is returned.", entry.href);
    const guestTexts = buttons.map(button => (button.innerText || "").replace(/\s+/g, " ").trim().replace(/^GUESTS\s+/i, "")).filter(value => /^[0-9]+ guests?$/.test(value));
    if (guestTexts.length !== 1 || Number(guestTexts[0].split(" ")[0]) !== input.adults) return fail("wrong_page", "The rendered guest count is missing or differs from the requested adult guests.", entry.href);
    const reserve = panel.querySelector('[data-testid="homes-pdp-cta-btn"]');
    if (!enabled(reserve) || (reserve.innerText || "").trim() !== "Reserve") return fail("site_changed", "The page does not show the supported enabled Reserve preview; no availability claim is made.", entry.href);
    const priceBlock = panel.querySelector('[data-xray-jira-component="Guest: Price Display: P3"]');
    if (!visible(priceBlock)) return fail("site_changed", "The supported visible price region is missing.", entry.href);
    const prices = [...priceBlock.querySelectorAll("button")].filter(visible).filter(button => /Show price breakdown/.test(button.innerText || ""));
    if (prices.length !== 1 || !enabled(prices[0])) return fail("site_changed", "The public preview has no supported enabled display-price control.", entry.href);
    const price = (prices[0].innerText || "").replace(/\s*Show price breakdown\s*/, "").trim();
    if (price.length > 500 || !/^\$(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{2})?(?:\s+\$(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{2})?)?$/.test(price)) return fail("site_changed", "The USD display-price format is unsupported.", entry.href);
    const qualifier = "for " + nights + " " + (nights === 1 ? "night" : "nights");
    const qualifierLines = (priceBlock.innerText || "").split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(line => /\bfor [0-9]+ nights?\b/.test(line));
    const allowedLines = new Set([qualifier, price.replace(/\s+/g, " ") + " " + qualifier, ...price.split(/\s+/).map(value => value + " " + qualifier)]);
    if (!qualifierLines.length || qualifierLines.some(line => !allowedLines.has(line)) || /per night/i.test(priceBlock.innerText || "")) return fail("site_changed", "The price region has no unambiguous total-stay qualifier.", entry.href);
    const terms = panelText.split("\n").map(line => line.trim()).filter(line => /today|Free cancellation/.test(line)).join(" · ").slice(0, 600) || null;
    return {
      status: "prepared", listing_id: input.listing_id, handoff_url: entry.href,
      checkin: input.checkin, checkout: input.checkout, adults: input.adults, nights, requested_currency: "USD",
      displayed_price_text: price + " " + qualifier, guests_text: guestTexts[0], terms_summary: terms,
      terms_complete: false, reservation_created: false, execution_supported: false,
      warnings: ["This is displayed preliminary pricing, not a final checkout total or guaranteed availability.", "Full taxes, fees, cancellation/payment conditions and house rules must be reviewed by the human on Airbnb.", "No reservation, hold, message or terms acceptance occurred; final execution is not supported."],
      observed_at: new Date().toISOString()
    };
  }
}]

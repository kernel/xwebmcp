[{
  kind: "page",
  match: { url_patterns: ["https://secure.booking.com/*"] },
  tool: {
    name: "fill_guest_details",
    description: "Enter the main guest's personal details into Booking.com's \"Your details\" checkout step open in this tab (secure.booking.com/book.html, or tpi_book for a Partner Offer; reached with select_room): first and last name, email, phone and, when the page asks for them, address, city, zip code and country. This tool types personal data into the site's form; pass only details the user gave you. It also unticks the optional \"Sign in to save\" offer, which would otherwise open a sign-in dialog when continuing. It does not press any button: call continue_checkout next. Returns the fields it filled and any required field the page still shows empty or invalid. Elsewhere it returns wrong_page. English pages only.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["first_name", "last_name", "email", "phone"],
      properties: {
        first_name: { type: "string", minLength: 1, maxLength: 60 },
        last_name: { type: "string", minLength: 1, maxLength: 60 },
        email: { type: "string", maxLength: 120, description: "Booking.com sends the confirmation here." },
        phone: { type: "string", maxLength: 20, description: "Digits, spaces, +, - and parentheses, without the country code the page selects from country." },
        address: { type: "string", minLength: 1, maxLength: 120 },
        city: { type: "string", minLength: 1, maxLength: 80 },
        zip: { type: "string", minLength: 1, maxLength: 20 },
        country: { type: "string", pattern: "^[A-Za-z]{2}$", description: "ISO 3166-1 alpha-2 code, for example US; sets the address country and the phone country code." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "filled", "missing_fields", "invalid_fields", "sign_in_offer_declined", "next_tool"],
          properties: {
            status: { const: "filled" },
            filled: { type: "array", items: { type: "string" }, description: "Input fields that now hold the given values." },
            missing_fields: { type: "array", items: { type: "string", maxLength: 100 }, description: "Labels of required fields the page still shows empty; continue_checkout refuses until they are filled." },
            invalid_fields: { type: "array", items: { type: "string", maxLength: 100 }, description: "Labels of fields the page marks invalid." },
            sign_in_offer_declined: { type: "boolean", description: "True when the tool unticked the \"Sign in to save\" offer." },
            next_tool: { const: "continue_checkout" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "unsupported_language", "site_changed"] },
            error_message: { type: "string", maxLength: 400 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const fail = (error_kind, error_message) => ({ status: "error", error_kind, error_message });
    const keys = ["first_name", "last_name", "email", "phone", "address", "city", "zip", "country"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) return fail("invalid_input", "Input may contain only " + keys.join(", ") + ".");
    const limits = { first_name: 60, last_name: 60, email: 120, phone: 20, address: 120, city: 80, zip: 20, country: 2 };
    for (const key of keys) {
      const value = input[key];
      if (value === undefined && !["first_name", "last_name", "email", "phone"].includes(key)) continue;
      if (typeof value !== "string" || !value.trim() || value.length > limits[key] || /[\u0000-\u001f\u007f]/.test(value)) return fail("invalid_input", key + " must be non-empty text of at most " + limits[key] + " characters.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) return fail("invalid_input", "email must be an email address.");
    if (!/^[0-9 +()-]{5,20}$/.test(input.phone)) return fail("invalid_input", "phone may contain only digits, spaces, +, - and parentheses.");
    if (input.country !== undefined && !/^[A-Za-z]{2}$/.test(input.country)) return fail("invalid_input", "country must be a two-letter ISO code such as US.");
    const partnerPage = /^\/tpi_book(?:\.[a-z]{2}(?:-[a-z]{2})?)?\.html$/.test(window.location.pathname);
    if (window.location.origin !== "https://secure.booking.com" || (window.location.pathname !== "/book.html" && !partnerPage)) return fail("wrong_page", "This is not Booking.com's checkout page; use select_room on a property page to get there.");
    if (!/^en(-|$)/i.test(document.documentElement.getAttribute("lang") || "")) return fail("unsupported_language", "This tool reads English labels; switch the Booking.com page language to English first.");
    const tid = id => document.querySelector('[data-testid="' + id + '"]');
    const form = document.querySelector("form#bookForm");
    const container = tid("user-details-container") || (partnerPage && form?.querySelector('input[name="firstname"]') ? form : null);
    if (!container) return fail("wrong_page", "The checkout page is not on the \"Your details\" step.");
    // Booking.com's own checkout marks its fields with test ids; the partner checkout only names them.
    const field = (id, name) => tid(id) || container.querySelector('[name="' + name + '"]');
    const shown = el => !!el && el.getClientRects().length > 0;
    // React keeps its own copy of the value; set it through the native setter and announce the change.
    const set = (el, value) => {
      const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      for (const type of ["input", "change", "blur"]) el.dispatchEvent(new Event(type, { bubbles: true }));
    };
    const fields = { first_name: field("user-details-firstname", "firstname"), last_name: field("user-details-lastname", "lastname"), email: field("user-details-email", "email"), address: field("user-details-address1", "address1"), city: field("user-details-city", "city"), zip: field("user-details-zip", "zip"), phone: field("phone-number-input", "phone__number") };
    const countrySelects = [field("user-details-cc1", "cc1"), field("phone-country-code-select", "phone__country")];
    const country = input.country?.toLowerCase();
    for (const select of countrySelects) {
      if (country && shown(select) && ![...select.options].some(o => o.value === country)) return fail("invalid_input", "The page does not offer country " + input.country + ".");
    }
    if (!shown(fields.first_name) || !shown(fields.last_name) || !shown(fields.email) || !shown(fields.phone)) return fail("site_changed", "The page does not show the name, email and phone fields this tool fills.");

    const filled = [];
    if (country) for (const select of countrySelects) if (shown(select)) { set(select, country); filled.push(select.name); }
    for (const [key, el] of Object.entries(fields)) {
      if (input[key] === undefined || !shown(el)) continue;
      set(el, input[key]);
      filled.push(el.name || key);
    }
    const offer = tid("user-details-sign-in-to-save");
    const declined = !!(shown(offer) && offer.checked);
    if (declined) offer.click();

    const rawLabel = el => (document.querySelector('label[for="' + el.id + '"]')?.textContent || el.getAttribute("aria-label") || el.name || "").replace(/\s+/g, " ").trim();
    const labelOf = el => rawLabel(el).replace(/\*$/, "").trim().slice(0, 100);
    // The partner checkout marks required fields only with an asterisk in the label.
    const required = el => el.required || /\*$/.test(rawLabel(el));
    const inputs = [...(container.closest("form") || container).querySelectorAll("input, select, textarea")].filter(el => shown(el) && el.type !== "hidden" && el.type !== "checkbox" && el.type !== "radio");
    return {
      status: "filled", filled,
      missing_fields: inputs.filter(el => required(el) && !el.value.trim()).map(labelOf),
      invalid_fields: inputs.filter(el => el.getAttribute("aria-invalid") === "true").map(labelOf),
      sign_in_offer_declined: declined,
      next_tool: "continue_checkout"
    };
  }
}]

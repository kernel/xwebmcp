[{
  kind: "page",
  match: { url_patterns: ["https://www.zillow.com/*"] },
  tool: {
    name: "prepare_contact",
    title: "Preview a Zillow listing-agent contact request",
    description: "Prepare a local review-only contact preview for an exact public property and supplied name, email, phone and message. First navigate manually to the property and open its Contact Listing Agent dialog. Requires that exact property URL and the observed contact form. Reads the displayed consent disclosure; returns the supplied details for review but never fills fields, dispatches events, accepts terms, clicks Contact Agent, or sends a request. No account fields or prefilled values are read. Preparation is not approval or submission; final execution is not implemented. Tool output contains the personal details you supplied; do not share it with other parties without authorization.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["listing_url", "name", "email", "phone", "message"],
      properties: {
        listing_url: { type: "string", maxLength: 500, pattern: "^https://www\\.zillow\\.com/homedetails/[A-Za-z0-9_-]+/[1-9][0-9]{0,14}_zpid/$" },
        name: { type: "string", minLength: 1, maxLength: 100 },
        email: { type: "string", minLength: 3, maxLength: 254 },
        phone: { type: "string", minLength: 7, maxLength: 30 },
        message: { type: "string", minLength: 1, maxLength: 2000 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "zpid", "listing_url", "recipient_role", "preview", "consent_disclosure", "fields_filled", "submitted", "next_step"],
          properties: {
            status: { const: "prepared" }, zpid: { type: "string", pattern: "^[1-9][0-9]{0,14}$" },
            listing_url: { type: "string", maxLength: 500, pattern: "^https://www\\.zillow\\.com/homedetails/[A-Za-z0-9_-]+/[1-9][0-9]{0,14}_zpid/$" },
            recipient_role: { const: "listing_agent" },
            preview: {
              type: "object", additionalProperties: false, required: ["name", "email", "phone", "message"],
              properties: {
                name: { type: "string", minLength: 1, maxLength: 100 }, email: { type: "string", minLength: 3, maxLength: 254 },
                phone: { type: "string", minLength: 7, maxLength: 30 }, message: { type: "string", minLength: 1, maxLength: 2000 }
              }
            },
            consent_disclosure: { type: "string", minLength: 1, maxLength: 3000 },
            fields_filled: { const: false }, submitted: { const: false },
            next_step: { const: "Review the recipient and disclosure in Zillow, then enter details and submit manually only if you choose. No execution tool is provided." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "wrong_property", "challenge", "form_not_open", "site_changed", "canceled"] },
            error_message: { type: "string", minLength: 1, maxLength: 300 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context = {}) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const keys = ["listing_url", "name", "email", "phone", "message"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) return fail("invalid_input", "Provide only listing_url, name, email, phone and message.");
    const pattern = /^https:\/\/www\.zillow\.com\/homedetails\/[A-Za-z0-9_-]{1,200}\/([1-9][0-9]{0,14})_zpid\/$/;
    const match = typeof input.listing_url === "string" && input.listing_url.length <= 500 && input.listing_url.match(pattern);
    if (!match) return fail("invalid_input", "Use an exact canonical www.zillow.com property URL without query, fragment or credentials.");
    for (const [key, max] of [["name", 100], ["email", 254], ["phone", 30], ["message", 2000]]) {
      if (typeof input[key] !== "string" || !input[key].trim() || input[key].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input[key])) return fail("invalid_input", "Supply nonempty bounded text for each contact field without control characters.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || !/^\+?[0-9 ()-]{7,30}$/.test(input.phone) || input.phone.replace(/\D/g, "").length < 7) return fail("invalid_input", "Supply an email address and phone number in the documented formats.");
    if (context.signal?.aborted) return fail("canceled", "The preview was canceled.");
    if (location.origin !== "https://www.zillow.com") return fail("wrong_page", "Navigate manually to the public Zillow property page first.");
    if (/access to this page has been denied|browsing activity has been paused|verify you are human/i.test(document.title) || document.getElementById("px-captcha")) return fail("challenge", "Zillow is showing a verification challenge; nothing was prepared.");
    if (location.origin + location.pathname !== input.listing_url) return fail("wrong_property", "The current property URL does not exactly match listing_url; nothing was prepared.");
    const visible = node => node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden" && getComputedStyle(node).display !== "none";
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible);
    const dialog = dialogs.find(node => Array.from(node.querySelectorAll("h4")).some(heading => heading.textContent.trim() === "Contact Listing Agent"));
    if (!dialog) return fail("form_not_open", "Open Contact Listing Agent manually on this property. No dialog was opened or fields filled.");
    const forms = dialog.querySelectorAll('[data-testid="contact-form"] form');
    if (forms.length !== 1) return fail("site_changed", "The listing-agent contact form is missing or ambiguous.");
    const form = forms[0];
    for (const [selector, label] of [['input[name="name"][type="text"]', "Name"], ['input[name="phone"][type="tel"]', "Phone"], ['input[name="email"][type="email"]', "Email"], ['textarea[name="message"]', "Message"]]) {
      const fields = form.querySelectorAll(selector);
      if (fields.length !== 1 || !visible(fields[0]) || fields[0].disabled || fields[0].readOnly || fields[0].getAttribute("aria-label") !== label || fields[0].getAttribute("aria-required") !== "true") return fail("site_changed", "The expected contact fields are missing, disabled or changed.");
    }
    const buttons = Array.from(form.querySelectorAll("button")).filter(button => button.textContent.trim() === "Contact Agent");
    if (buttons.length !== 1 || !visible(buttons[0])) return fail("site_changed", "The contact submission control changed; nothing was prepared.");
    const paragraphs = Array.from(dialog.querySelectorAll("p")).filter(visible);
    const disclosure = paragraphs.map(node => node.textContent.trim()).find(value => value.startsWith("By pressing Contact Agent,"));
    if (!disclosure || disclosure.length > 3000 || !/Terms of Use/.test(disclosure)) return fail("site_changed", "The contact consent disclosure is missing or unsupported; nothing was prepared.");
    return {
      status: "prepared", zpid: match[1], listing_url: input.listing_url, recipient_role: "listing_agent",
      preview: { name: input.name, email: input.email, phone: input.phone, message: input.message },
      consent_disclosure: disclosure, fields_filled: false, submitted: false,
      next_step: "Review the recipient and disclosure in Zillow, then enter details and submit manually only if you choose. No execution tool is provided."
    };
  }
}]

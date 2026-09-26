[{
  kind: "cdp",
  match: { url_patterns: ["https://etsy.com/*", "https://*.etsy.com/*"] },
  tool: {
    name: "add_to_cart",
    title: "Add an Etsy listing to the cart",
    description: "Add one Etsy listing to this browser session's cart (the signed-in account's cart, or the guest cart when signed out) with exactly the options and personalization the seller requires. Call get_listing first: every variation menu must be given one option by its exact label or option_id, every required personalization field must be filled within its character limit, and dropdown personalization must use one of the listed options. Also follow the seller's instructions text for each field (it can state a tighter format or length than Etsy enforces); the tool checks only Etsy's own limits. Nothing is guessed or auto-filled: any missing, unknown, ambiguous, sold-out or over-long choice returns a typed error before anything is submitted. The tool opens the listing page in this tab, sets the choices through Etsy's own form, submits it once, never retries, and confirms the new cart line by reading the cart. Upload-type personalization is not supported. Never checks out or pays.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["listing_id"],
      properties: {
        listing_id: { type: "string", pattern: "^[0-9]{4,15}$", description: "Numeric Etsy listing id from search or get_listing." },
        quantity: { type: "integer", minimum: 1, maximum: 10, default: 1, description: "Units to add. Must not exceed the listing's quantity menu; listings without a quantity menu accept only 1." },
        variations: {
          type: "array", maxItems: 10,
          description: "One entry per variation menu from get_listing.variations, in any order.",
          items: {
            type: "object", additionalProperties: false, required: ["option"], anyOf: [{ required: ["name"] }, { required: ["index"] }],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 120, description: "Variation name exactly as get_listing reports it (case and surrounding spaces ignored), e.g. \"Size & Color\"." },
              index: { type: "integer", minimum: 0, maximum: 9, description: "Variation index from get_listing; use when the menu has no name." },
              option: { type: "string", minLength: 1, maxLength: 200, description: "The option_id, or the option's label or display_text exactly as get_listing reports it (case and surrounding spaces ignored)." }
            }
          }
        },
        personalization: {
          type: "array", maxItems: 10,
          description: "Values for personalization fields from get_listing.personalization.fields. Omit a field to leave an optional field empty.",
          items: {
            type: "object", additionalProperties: false, required: ["value"],
            properties: {
              field: { type: "string", minLength: 1, maxLength: 200, description: "The field_id or the field label from get_listing. May be omitted when the listing has exactly one personalization field." },
              value: { type: "string", minLength: 1, maxLength: 1024, description: "Text for a text_input field (must fit max_chars), or the option_id or label of a dropdown field." }
            }
          }
        }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "mutation_attempted", "listing_id", "quantity_added", "previous_quantity", "line", "selections", "personalization", "personalization_confirmed", "cart_line_count"],
          properties: {
            status: { const: "ok" },
            mutation_attempted: { const: true },
            listing_id: { type: "string" },
            quantity_added: { type: "integer", minimum: 1 },
            previous_quantity: { type: "integer", minimum: 0, description: "Quantity of this exact line before the add (0 when the line is new)." },
            line: {
              type: "object", additionalProperties: false,
              required: ["line_id", "cart_id", "listing_id", "inventory_id", "customization_id", "title", "shop_name", "quantity", "max_quantity", "unit_price", "regular_price", "available", "properties", "url"],
              properties: {
                line_id: { type: "string", pattern: "^[0-9]+\\|[0-9]+\\|[0-9]+\\|[0-9]+$" },
                cart_id: { type: "string" }, listing_id: { type: "string" }, inventory_id: { type: "string" }, customization_id: { type: "string" },
                title: { type: ["string", "null"] }, shop_name: { type: ["string", "null"] },
                quantity: { type: "integer", minimum: 0 }, max_quantity: { type: ["integer", "null"] },
                unit_price: { type: ["number", "null"] }, regular_price: { type: ["number", "null"] },
                available: { type: "boolean" },
                properties: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } } } },
                url: { type: "string" }
              }
            },
            selections: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "option_id", "label"], properties: { name: { type: ["string", "null"] }, option_id: { type: "string" }, label: { type: "string" } } } },
            personalization: { type: "array", items: { type: "object", additionalProperties: false, required: ["field_id", "label", "value"], properties: { field_id: { type: "string" }, label: { type: ["string", "null"] }, value: { type: "string" } } } },
            personalization_confirmed: { type: "boolean", description: "True when every personalization text appears in the cart line as Etsy displays it." },
            cart_line_count: { type: "integer", minimum: 0 }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message", "mutation_attempted"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "navigation_failed", "blocked", "listing_not_found", "listing_unavailable", "variation_required", "unknown_variation", "variation_option_not_found", "variation_option_unavailable", "personalization_required", "personalization_too_long", "personalization_not_offered", "unknown_personalization_field", "personalization_option_not_found", "personalization_unsupported", "quantity_unavailable", "site_validation_failed", "site_changed", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            mutation_attempted: { type: "boolean", description: "True once the add-to-cart form was submitted, even if the outcome is uncertain; read the cart before retrying." },
            requirements: { type: ["object", "null"], additionalProperties: true, description: "For requirement errors: the relevant variation menu or personalization field with its allowed options, so the caller can choose explicitly." }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  execute: async (input) => {
    const origin = "https://www.etsy.com";
    const fail = (kind, message, extra = {}) => ({ status: "error", error_kind: kind, error_message: message, mutation_attempted: false, ...extra });
    // Page-context requests below use relative URLs, so the tab must be on www.etsy.com itself (not help.etsy.com etc.).
    const onSite = url => { try { const u = new URL(url); return u.protocol === "https:" && u.hostname === "www.etsy.com"; } catch { return false; } };
    const bad = message => fail("invalid_input", message + " Nothing was added.");
    if (!input || typeof input !== "object" || Array.isArray(input)) return bad("Input must be an object.");
    const extra = Object.keys(input).find(k => !["listing_id", "quantity", "variations", "personalization"].includes(k));
    if (extra) return bad(`Unrecognized input field "${extra}".`);
    if (typeof input.listing_id !== "string" || !/^[0-9]{4,15}$/.test(input.listing_id)) return bad("listing_id must be the numeric Etsy listing id as a string.");
    const quantity = input.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) return bad("quantity must be an integer from 1 to 10.");
    const variations = input.variations ?? [];
    if (!Array.isArray(variations) || variations.length > 10) return bad("variations must be an array of at most 10 entries.");
    for (const v of variations) {
      if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["name", "index", "option"].includes(k))) return bad("Each variations entry takes only name, index and option.");
      if (typeof v.option !== "string" || !v.option.trim() || v.option.length > 200) return bad("Each variations entry needs an option (1 to 200 characters).");
      if (v.name !== undefined && (typeof v.name !== "string" || !v.name.trim() || v.name.length > 120)) return bad("A variation name must be 1 to 120 characters.");
      if (v.index !== undefined && (!Number.isInteger(v.index) || v.index < 0 || v.index > 9)) return bad("A variation index must be an integer from 0 to 9.");
      if (v.name === undefined && v.index === undefined) return bad("Each variations entry needs a name or an index.");
    }
    const personalization = input.personalization ?? [];
    if (!Array.isArray(personalization) || personalization.length > 10) return bad("personalization must be an array of at most 10 entries.");
    for (const p of personalization) {
      if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some(k => !["field", "value"].includes(k))) return bad("Each personalization entry takes only field and value.");
      if (typeof p.value !== "string" || !p.value.length || p.value.length > 1024) return bad("Each personalization entry needs a value of 1 to 1024 characters.");
      if (p.field !== undefined && (typeof p.field !== "string" || !p.field.trim() || p.field.length > 200)) return bad("A personalization field must be 1 to 200 characters.");
    }
    const id = input.listing_id;

    // Runs in the page: reads the live buy box and resolves the request against the seller's requirements.
    // Nothing on the page is changed here.
    const resolve = (arg) => {
      const clean = s => (s || "").replace(/\s+/g, " ").trim();
      const norm = s => clean(s).toLowerCase().replace(/[:?]+$/, "").trim();
      const decode = s => { const t = document.createElement("textarea"); t.innerHTML = s || ""; return t.value; };
      const failure = (kind, message, requirements = null) => ({ error: { kind, message, requirements } });
      const blocked = !!document.querySelector('iframe[src*="captcha-delivery.com"]');
      if (blocked) return failure("blocked", "Etsy's bot protection is showing a verification page in this tab. Complete it in the browser or retry from another network; nothing was added.");
      if (!location.pathname.startsWith(`/listing/${arg.id}`)) return failure("listing_not_found", `Etsy did not show listing ${arg.id} (landed on ${location.pathname}); it is unavailable or removed. Nothing was added.`);
      const form = [...document.querySelectorAll('form[action*="/cart/listing.php"]')].find(f => f.querySelector('input[name="listing_id"]')?.value === arg.id && !f.closest("[data-listing-card-v2], [data-palette-listing-id]"));
      const product = [...document.querySelectorAll('script[type="application/ld+json"]')].some(s => /"@type"\s*:\s*"Product"/.test(s.textContent || ""));
      if (!form && !product) return failure("listing_not_found", `Etsy shows no listing ${arg.id} (the page has no product); it is unavailable or removed. Nothing was added.`);
      if (!form) return failure("listing_unavailable", `Listing ${arg.id} has no add-to-cart form (sold out, inactive, or not purchasable by this account). Nothing was added.`);
      const pricePattern = /\s*\(([^()]*\d[^()]*)\)\s*$/;
      const menus = [...document.querySelectorAll('select[id^="variation-selector-"]')].map((select, index) => {
        const label = document.querySelector(`label[for="${select.id}"]`) || (select.getAttribute("aria-labelledby") ? document.getElementById(select.getAttribute("aria-labelledby")) : null);
        return {
          index, element_id: select.id, name: label ? clean(label.textContent) || null : null,
          options: [...select.options].filter(o => o.value).map(o => {
            const display = clean(o.textContent);
            let base = display.replace(/\s*\[Sold out\]\s*$/i, "");
            const priced = base.match(pricePattern);
            if (priced && /^[^\d()]{0,4}\d[\d.,]*\+?(\s*[-–]\s*[^\d()]{0,4}\d[\d.,]*\+?)?$/.test(priced[1].trim())) base = base.replace(pricePattern, "");
            return { option_id: o.value, label: clean(base), display_text: display, sold_out: o.disabled || /\[Sold out\]/i.test(display) };
          })
        };
      });
      const describeMenu = m => ({ variation: { index: m.index, name: m.name, options: m.options.map(o => ({ option_id: o.option_id, label: o.label, sold_out: o.sold_out })) } });
      const used = new Set();
      const selections = [];
      for (const menu of menus) {
        const matches = arg.variations.map((v, i) => ({ v, i })).filter(({ v }) => (v.index !== undefined && v.index === menu.index && (v.name === undefined || norm(v.name) === norm(menu.name))) || (v.index === undefined && v.name !== undefined && menu.name && norm(v.name) === norm(menu.name)));
        if (!matches.length) return failure("variation_required", `Choose an option for "${menu.name || `variation ${menu.index}`}"; Etsy requires every variation. Nothing was added.`, describeMenu(menu));
        if (matches.length > 1) return failure("invalid_input", `More than one entry was given for "${menu.name || `variation ${menu.index}`}". Nothing was added.`, describeMenu(menu));
        const { v, i } = matches[0];
        used.add(i);
        const wanted = norm(v.option);
        const hits = menu.options.filter(o => o.option_id === v.option.trim() || norm(o.label) === wanted || norm(o.display_text) === wanted);
        if (!hits.length) return failure("variation_option_not_found", `"${v.option}" is not an option of "${menu.name || `variation ${menu.index}`}". Use one of the listed labels or option ids exactly. Nothing was added.`, describeMenu(menu));
        if (hits.length > 1) return failure("variation_option_not_found", `"${v.option}" matches more than one option of "${menu.name || `variation ${menu.index}`}"; pass its option_id. Nothing was added.`, describeMenu(menu));
        if (hits[0].sold_out) return failure("variation_option_unavailable", `"${hits[0].label}" of "${menu.name || `variation ${menu.index}`}" is sold out${selections.length ? " with the options already chosen" : ""}. Nothing was added.`, describeMenu(menu));
        selections.push({ index: menu.index, element_id: menu.element_id, name: menu.name, option_id: hits[0].option_id, label: hits[0].label });
      }
      const unused = arg.variations.findIndex((v, i) => !used.has(i));
      if (unused >= 0) return failure("unknown_variation", `This listing has no variation ${arg.variations[unused].name !== undefined ? `"${arg.variations[unused].name}"` : `index ${arg.variations[unused].index}`}. Nothing was added.`, { variations: menus.map(m => ({ index: m.index, name: m.name })) });

      const fields = [...document.querySelectorAll("li[data-field-id]")].filter(li => form.contains(li) || li.closest('[data-appears-component-name="personalization"]')).map(li => {
        const type = li.getAttribute("data-field-type") || "unknown";
        const select = li.querySelector("select");
        const max = li.querySelector("[data-max-char-count]");
        const input = li.querySelector("textarea, input[type=text]");
        const instructions = li.querySelector("[data-instructions]");
        return {
          field_id: li.getAttribute("data-field-id"), type,
          label: clean(li.querySelector("[data-label]")?.textContent || li.querySelector("label")?.textContent) || null,
          required: li.getAttribute("data-is-required") === "true",
          max_chars: max && /^\d+$/.test(max.getAttribute("data-max-char-count") || "") ? Number(max.getAttribute("data-max-char-count")) : null,
          instructions: instructions ? clean(decode(instructions.innerHTML.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, ""))).slice(0, 1000) || null : null,
          element_id: type === "dropdown" ? (select ? select.id : null) : (input ? input.id : null),
          options: type === "dropdown" && select ? [...select.options].filter(o => o.value).map(o => ({ option_id: o.value, label: clean(o.textContent) })) : null
        };
      });
      const legacy = document.querySelector('textarea#listing-page-personalization-textarea, textarea[name="personalization"]');
      if (legacy && !fields.length) {
        if (arg.personalization.length || legacy.hasAttribute("required") || legacy.getAttribute("aria-required") === "true") return failure("personalization_unsupported", "This listing uses Etsy's older single-box personalization, which this tool does not fill. Nothing was added.");
      }
      const describeField = f => ({ field: { field_id: f.field_id, type: f.type, label: f.label, required: f.required, max_chars: f.max_chars, instructions: f.instructions, options: f.options } });
      if (arg.personalization.length && !fields.length) return failure("personalization_not_offered", "This listing does not offer personalization; remove the personalization entries. Nothing was added.");
      const assigned = new Map();
      for (const p of arg.personalization) {
        let field = null;
        if (p.field === undefined) {
          if (fields.length !== 1) return failure("invalid_input", `This listing has ${fields.length} personalization fields; name the field for each value. Nothing was added.`, { fields: fields.map(f => describeField(f).field) });
          field = fields[0];
        } else {
          const hits = fields.filter(f => f.field_id === p.field.trim() || (f.label && norm(f.label) === norm(p.field)));
          if (!hits.length) return failure("unknown_personalization_field", `This listing has no personalization field "${p.field}". Nothing was added.`, { fields: fields.map(f => describeField(f).field) });
          if (hits.length > 1) return failure("unknown_personalization_field", `"${p.field}" matches more than one personalization field; pass its field_id. Nothing was added.`, { fields: hits.map(f => describeField(f).field) });
          field = hits[0];
        }
        if (assigned.has(field.field_id)) return failure("invalid_input", `More than one value was given for personalization field "${field.label || field.field_id}". Nothing was added.`, describeField(field));
        assigned.set(field.field_id, p.value);
      }
      const persos = [];
      for (const field of fields) {
        const value = assigned.get(field.field_id);
        if (value === undefined || !value.trim()) {
          if (field.required) return failure("personalization_required", `The seller requires "${field.label || "personalization"}"${field.max_chars ? ` (up to ${field.max_chars} characters)` : ""}. Nothing was added.`, describeField(field));
          continue;
        }
        if (field.type === "text_input") {
          if (!field.element_id) return failure("site_changed", `The text box for "${field.label}" was not found on the listing page. Nothing was added.`, describeField(field));
          if (field.max_chars && [...value].length > field.max_chars) return failure("personalization_too_long", `"${field.label || "Personalization"}" allows at most ${field.max_chars} characters; the value has ${[...value].length}. Nothing was added.`, describeField(field));
          persos.push({ field_id: field.field_id, type: field.type, label: field.label, element_id: field.element_id, value });
        } else if (field.type === "dropdown") {
          const hits = (field.options || []).filter(o => o.option_id === value.trim() || norm(o.label) === norm(value));
          if (hits.length !== 1) return failure("personalization_option_not_found", `"${value}" is not ${hits.length ? "a unique" : "an"} option of "${field.label}". Use one of the listed labels or option ids exactly. Nothing was added.`, describeField(field));
          persos.push({ field_id: field.field_id, type: field.type, label: field.label, element_id: field.element_id, value: hits[0].option_id, option_label: hits[0].label });
        } else {
          return failure("personalization_unsupported", `Personalization field "${field.label || field.field_id}" has type ${field.type}, which this tool cannot fill. Nothing was added.`, describeField(field));
        }
      }
      const quantitySelect = document.getElementById("listing-page-quantity-select");
      const quantities = quantitySelect ? [...quantitySelect.options].map(o => Number(o.value)).filter(n => Number.isInteger(n) && n > 0) : [];
      if (!quantities.length && arg.quantity !== 1) return failure("quantity_unavailable", "This listing offers no quantity menu, so only quantity 1 can be added. Nothing was added.", { quantity: { selectable: false, max: 1 } });
      if (quantities.length && !quantities.includes(arg.quantity)) return failure("quantity_unavailable", `Etsy allows quantities ${Math.min(...quantities)} to ${Math.max(...quantities)} for this listing${selections.length ? " with these options" : ""}. Nothing was added.`, { quantity: { selectable: true, max: Math.max(...quantities) } });
      return { selections, persos, hasQuantityMenu: quantities.length > 0 };
    };

    const readError = (resolved) => resolved.error ? fail(resolved.error.kind, resolved.error.message, resolved.error.requirements ? { requirements: resolved.error.requirements } : {}) : null;

    let clicked = false;
    try {
      if (!onSite((await pageInfo()).url)) {
        try {
          await gotoUrl(origin + "/");
          await waitForLoad(30);
        } catch (error) {
          return fail("navigation_failed", "Could not open etsy.com in this tab: " + (error && error.message ? error.message : String(error)) + ". Nothing was added.");
        }
        if (!onSite((await pageInfo()).url)) return fail("navigation_failed", "Could not open www.etsy.com in this tab. Nothing was added.");
      }
      // Cart before the add, read with the page's own session.
      const readCart = () => js(async () => {
        const response = await fetch("/cart", { credentials: "include" });
        const html = await response.text();
        if (response.status >= 400 || (html.length < 50000 && /captcha-delivery\.com/.test(html))) return { error: `HTTP ${response.status}` };
        const doc = new DOMParser().parseFromString(html, "text/html");
        const clean = s => (s || "").replace(/\s+/g, " ").trim();
        const num = s => { const n = Number(s); return s !== null && s !== "" && Number.isFinite(n) ? n : null; };
        const lines = [];
        for (const li of doc.querySelectorAll("li[data-cart-listing]")) {
          if (li.closest('[id*="saved-for-later"], [class*="saved-for-later"], [data-saved-for-later]')) continue;
          const d = li.dataset;
          const key = li.querySelector("[data-listing-key]")?.getAttribute("data-listing-key") || "";
          let cartId = /^[0-9]+\|/.test(key) ? key.split("|")[0] : "";
          let node = li;
          while (!cartId && node && node !== doc.body) { node = node.parentElement; const hidden = node && node.querySelector('input[name="cart_ids[]"]'); if (hidden) cartId = hidden.value; }
          const listingId = d.listingId || "", inventoryId = d.listingInventoryId || "", customizationId = d.listingCustomizationId || "0";
          if (!/^[0-9]+$/.test(cartId) || !/^[0-9]+$/.test(listingId) || !/^[0-9]+$/.test(inventoryId) || !/^[0-9]+$/.test(customizationId)) continue;
          const pattern = /^([^:]{1,80}):\s+(\S.{0,1500})$/;
          const candidates = [...li.querySelectorAll("p, span, div, li, dd, dt")].filter(el => pattern.test(clean(el.textContent)) && !el.querySelector("select, button, a, img"));
          const smallest = candidates.filter(el => ![...el.querySelectorAll("*")].some(child => candidates.includes(child)));
          const properties = [];
          for (const el of smallest) {
            const m = clean(el.textContent).match(pattern);
            if (m && !properties.some(p => p.name === m[1].trim() && p.value === m[2].trim())) properties.push({ name: m[1].trim(), value: m[2].trim() });
          }
          const quantities = [...li.querySelectorAll('select[name="listing-quantity"] option')].map(o => Number(o.value)).filter(n => Number.isInteger(n) && n > 0);
          let section = li.parentElement;
          while (section && section !== doc.body && !section.querySelector('[data-selector="shop-name"]')) section = section.parentElement;
          const link = li.querySelector('a[href*="/listing/"]');
          let url = `${location.origin}/listing/${listingId}`;
          try { if (link) { const u = new URL(link.getAttribute("href"), location.origin); url = u.origin + u.pathname; } } catch { }
          lines.push({
            line_id: `${cartId}|${listingId}|${inventoryId}|${customizationId}`,
            cart_id: cartId, listing_id: listingId, inventory_id: inventoryId, customization_id: customizationId,
            title: clean(d.listingTitle) || null,
            shop_name: section && section !== doc.body ? clean(section.querySelector('[data-selector="shop-name"]').textContent) || null : null,
            quantity: Number.isInteger(Number(d.listingQuantity)) ? Number(d.listingQuantity) : 0,
            max_quantity: quantities.length ? Math.max(...quantities) : null,
            unit_price: num(d.listingUnitPrice ?? null),
            regular_price: num(d.listingRegularPrice ?? null),
            available: d.listingAvailable !== "false",
            properties,
            url
          });
        }
        return { lines };
      });
      const before = await readCart();
      if (before.error) return fail("unknown", `Could not read the cart before adding (${before.error}); nothing was added.`);

      try {
        await gotoUrl(`${origin}/listing/${id}`);
        await waitForLoad(30);
      } catch (error) {
        return fail("navigation_failed", "Could not open the listing page: " + (error && error.message ? error.message : String(error)) + ". Nothing was added.");
      }
      const arg = { id, quantity, variations: variations.map(v => ({ name: v.name, index: v.index, option: v.option })), personalization: personalization.map(p => ({ field: p.field, value: p.value })) };
      // The buy box can render a moment after load; give a missing form a few seconds before calling the listing unavailable.
      let resolved = null;
      for (let i = 0; i < 6; i++) {
        resolved = await js(resolve, { arg });
        if (!resolved.error || resolved.error.kind !== "listing_unavailable") break;
        await waitMs(500);
      }
      const early = readError(resolved);
      if (early) return early;

      // Etsy reloads the buy box after each variation change, which can re-render the menus
      // and change which later options are available; set them one at a time and re-check.
      const settle = async () => {
        for (let i = 0; i < 20; i++) {
          await waitMs(400);
          const busy = await js(() => { const s = document.querySelector("[data-buy-box-price-spinner]"); return !!s && !s.classList.contains("wt-display-none"); });
          if (!busy) return;
        }
      };
      for (const s of resolved.selections) {
        const ok = await js((a) => {
          const select = document.getElementById(a.element_id);
          if (!select || ![...select.options].some(o => o.value === a.option_id)) return false;
          select.value = a.option_id;
          select.dispatchEvent(new Event("input", { bubbles: true }));
          select.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }, { arg: s });
        if (!ok) return fail("site_changed", `The "${s.name}" menu changed while options were being chosen. Nothing was added.`);
        await settle();
      }
      resolved = await js(resolve, { arg });
      const late = readError(resolved);
      if (late) return late;
      const selectedOk = await js((sel) => sel.every(s => document.getElementById(s.element_id)?.value === s.option_id), { arg: resolved.selections });
      if (!selectedOk) return fail("site_changed", "Etsy did not keep the chosen options in the listing form. Nothing was added.");

      if (resolved.persos.length) {
        await js(() => { const t = document.querySelector('[data-selector="enhanced-perso-content-toggle"]'); if (t && t.getAttribute("aria-expanded") === "false") t.click(); });
        await waitMs(600);
      }
      for (const p of resolved.persos) {
        if (p.type === "text_input") {
          await fillInput(`#${p.element_id}`, p.value);
        } else {
          await js((a) => { const s = document.getElementById(a.element_id); s.value = a.value; s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); }, { arg: p });
        }
        await waitMs(200);
      }
      if (resolved.hasQuantityMenu) {
        await js((q) => { const s = document.getElementById("listing-page-quantity-select"); s.value = String(q); s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); }, { arg: quantity });
        await settle();
      }
      // Check what the form will actually send before submitting it.
      const check = await js((a) => {
        const form = [...document.querySelectorAll('form[action*="/cart/listing.php"]')].find(f => f.querySelector('input[name="listing_id"]')?.value === a.id && !f.closest("[data-listing-card-v2], [data-palette-listing-id]"));
        if (!form) return { problem: "The add-to-cart form disappeared." };
        const quantityField = form.querySelector('input[name="quantity"]');
        if (quantityField && quantityField.value !== String(a.quantity)) return { problem: `The form holds quantity ${quantityField.value} instead of ${a.quantity}.` };
        for (const p of a.persos) {
          const el = document.getElementById(p.element_id);
          if (!el || el.value !== p.value) return { problem: `The personalization field "${p.label}" did not keep the requested value.` };
        }
        const raw = form.querySelector('input[name="multiple_personalizations"]')?.value || "";
        if (a.persos.length) {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { parsed = null; }
          if (!Array.isArray(parsed)) return { problem: "Etsy's personalization data was not readable." };
          for (const p of a.persos) {
            const entry = parsed.find(e => String(e.id) === p.field_id);
            const recorded = entry && (p.type === "text_input" ? entry.response === p.value : String(entry.option_id) === p.value);
            if (!recorded) return { problem: `Etsy's form did not record the value for "${p.label}".` };
          }
        }
        form.setAttribute("data-xwebmcp-add-to-cart", a.id);
        const buttons = [...form.querySelectorAll('button[type="submit"]')].filter(b => b.offsetParent !== null);
        if (buttons.length !== 1) return { problem: `Expected one visible add-to-cart button, found ${buttons.length}.` };
        return { problem: null };
      }, { arg: { id, quantity, persos: resolved.persos } });
      if (check.problem) return fail("site_changed", check.problem + " Nothing was added.");

      // Classic listings post the form to /cart/listing.php; listings with Etsy's newer buy box add
      // through /api/v3/ajax/member/carts/add and open a sidebar cart instead of navigating.
      const submitted = waitForEvent("Network.requestWillBeSent", { timeoutSec: 12, predicate: e => e.params.request.method === "POST" && /\/cart\/listing\.php|\/api\/v3\/ajax\/[a-z]+\/carts?\/add/.test(e.params.request.url) });
      clicked = true;
      await click(`form[data-xwebmcp-add-to-cart="${id}"] button[type="submit"]`);
      const request = await submitted;
      for (let i = 0; request && i < 40; i++) {
        await waitMs(500);
        const info = await pageInfo().catch(() => null);
        if (info && info.url && new URL(info.url).pathname.startsWith("/cart") && info.ready_state === "complete") break;
        if (i >= 6 && info && info.ready_state === "complete" && !/\/cart/.test(info.url)) break;
      }
      const grownLines = cart => cart.lines.filter(l => l.listing_id === id && l.quantity > ((before.lines.find(b => b.line_id === l.line_id) || {}).quantity || 0));
      let after = null;
      for (let i = 0; i < 3; i++) {
        after = await readCart().catch(() => ({ error: "read failed" }));
        if (!after.error && grownLines(after).length) break;
        await waitMs(1500);
      }
      if (!request && !after.error && !grownLines(after).length) {
        const messages = await js(() => [...document.querySelectorAll('[id^="error-variation-selector-"], [data-selector="personalization-error"], [id^="error-listing-page-quantity"]')]
          .filter(e => !e.closest(".wt-validation__message--is-hidden") && e.getClientRects().length && getComputedStyle(e).visibility !== "hidden")
          .map(e => (e.textContent || "").replace(/\s+/g, " ").trim()).filter(t => t && t.length < 300));
        if (messages.length) return fail("site_validation_failed", `Etsy refused the choices and did not add the item: ${[...new Set(messages)].join(" | ")}`);
      }
      const mutation = { mutation_attempted: true };
      if (after.error) return fail("unknown", "The add-to-cart button was pressed but the cart could not be read afterwards; read the cart with get_cart before retrying.", mutation);
      const grown = grownLines(after);
      if (grown.length !== 1) return fail("unknown", grown.length ? "The add-to-cart button was pressed and more than one cart line for this listing changed; read the cart with get_cart." : "The add-to-cart button was pressed but no cart line for this listing grew; Etsy may have rejected the choices. Read the cart with get_cart before retrying.", mutation);
      const line = grown[0];
      const previous = (before.lines.find(b => b.line_id === line.line_id) || {}).quantity || 0;
      const shown = line.properties.map(p => p.value).join(" \n ");
      const texts = resolved.persos.filter(p => p.type === "text_input");
      return {
        status: "ok", mutation_attempted: true, listing_id: id,
        quantity_added: line.quantity - previous, previous_quantity: previous, line,
        selections: resolved.selections.map(s => ({ name: s.name, option_id: s.option_id, label: s.label })),
        personalization: resolved.persos.map(p => ({ field_id: p.field_id, label: p.label, value: p.option_label || p.value })),
        personalization_confirmed: texts.every(p => shown.includes(p.value.replace(/\s+/g, " ").trim())),
        cart_line_count: after.lines.length
      };
    } catch (error) {
      return fail("unknown", "Browser interaction failed: " + (error && error.message ? error.message : String(error)) + (clicked ? ". The form may have been submitted; read the cart with get_cart before retrying." : ". Nothing was submitted."), { mutation_attempted: clicked });
    }
  }
}]

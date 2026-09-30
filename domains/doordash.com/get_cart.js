[{
  kind: "page",
  match: { url_patterns: ["https://www.doordash.com/*"] },
  tool: {
    name: "get_cart",
    description: "Read open DoorDash carts, line ids/options/quantities, currency and provisional subtotal/total/fee lines from the current authorized session. Requires expected_account_email (the intended account supplied by the user); checks the signed-in account before reading private carts, never returns email/payment data. Returns at most 20 carts, 100 lines and 50 options per line with truncation flags and a revision for remove_cart_item. Delivery context states the header basis and saved default region, not a verified cart address. Does not open checkout, set an address, add items, pay or place orders. Menu/item reads and adding items are native tools, not duplicated. Empty open-cart list is a valid success.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["expected_account_email"],
      properties: {
        expected_account_email: {
          type: "string",
          minLength: 3,
          maxLength: 254,
          pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
          description: "The intended account email supplied by the user. Compared with the current session before reading carts or changing anything; never returned. Not a human approval token."
        }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status","account_matched","carts","carts_truncated","delivery_context"],
          properties: {
            status: {"const":"ok"},
            account_matched: {"const":true},
            carts: {
              type: "array",
              maxItems: 20,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["cart_id","store_id","store_name","fulfillment_type","group_cart","bundle","catering","merchant_shipping","currency","subtotal_minor","total_minor","lines","fee_lines","revision","truncated"],
                properties: {
                  cart_id: {"type":"string","maxLength":64},
                  store_id: {"type":["string","null"],"maxLength":200},
                  store_name: {"type":["string","null"],"maxLength":200},
                  fulfillment_type: {"enum":["pickup","delivery","unknown"]},
                  group_cart: {"type":["boolean","null"]},
                  bundle: {"type":["boolean","null"]},
                  catering: {"type":["boolean","null"]},
                  merchant_shipping: {"type":["boolean","null"]},
                  currency: {"type":["string","null"],"maxLength":10},
                  subtotal_minor: {"type":["integer","null"]},
                  total_minor: {"type":["integer","null"]},
                  lines: {
                    type: "array",
                    maxItems: 100,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["line_id","item_id","name","quantity","unit_price_minor","total_minor","price_display","options"],
                      properties: {
                        line_id: {"type":"string","maxLength":64},
                        item_id: {"type":["string","null"],"maxLength":200},
                        name: {"type":["string","null"],"maxLength":200},
                        quantity: {"type":["number","null"]},
                        unit_price_minor: {"type":["integer","null"]},
                        total_minor: {"type":["integer","null"]},
                        price_display: {"type":["string","null"],"maxLength":200},
                        options: {
                          type: "array",
                          maxItems: 50,
                          items: {
                            type: "object",
                            additionalProperties: false,
                            required: ["option_id","name","quantity","price_minor"],
                            properties: {"option_id":{"type":"string","maxLength":64},"name":{"type":["string","null"],"maxLength":200},"quantity":{"type":["number","null"]},"price_minor":{"type":["integer","null"]}}
                          }
                        }
                      }
                    }
                  },
                  fee_lines: {
                    type: "array",
                    maxItems: 30,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["label","amount_minor","display"],
                      properties: {"label":{"type":["string","null"],"maxLength":200},"amount_minor":{"type":["integer","null"]},"display":{"type":["string","null"],"maxLength":200}}
                    }
                  },
                  revision: {"type":"string","pattern":"^[a-f0-9]{64}$"},
                  truncated: {"type":"boolean"}
                }
              }
            },
            carts_truncated: {"type":"boolean"},
            delivery_context: {
              type: "object",
              additionalProperties: false,
              required: ["basis","default_address_region","note"],
              properties: {
                basis: {"enum":["selected_address","no_address_selected","unknown"]},
                default_address_region: {
                  type: "object",
                  additionalProperties: false,
                  required: ["city","state","postal_code","country_code"],
                  properties: {
                    city: {"type":["string","null"],"maxLength":200},
                    state: {"type":["string","null"],"maxLength":200},
                    postal_code: {"type":["string","null"],"maxLength":200},
                    country_code: {"type":["string","null"],"maxLength":200}
                  }
                },
                note: {"type":"string","maxLength":500}
              }
            }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status","error_kind","error_message","write_attempted"],
          properties: {
            status: {"const":"error"},
            error_kind: {"enum":["invalid_input","wrong_page","login_required","wrong_account","blocked","rate_limited","site_changed","site_error","cancelled","not_found","stale_state","busy","outcome_unknown"]},
            error_message: {"type":"string","maxLength":400},
            write_attempted: {"type":"boolean"}
          }
        }
      ]
    },
    annotations: {"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"untrustedContentHint":true}
  },
  execute: async (input, context) => {
    const fail = (error_kind, error_message, write_attempted = false) => ({ status: "error", error_kind, error_message, write_attempted });
    const allowed = ["expected_account_email"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k)) || allowed.some(k => typeof input[k] !== "string") || input.expected_account_email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.expected_account_email)) return fail("invalid_input", "Supply only the documented fields, including the intended account email. No request was made.");

    if (location.origin !== "https://www.doordash.com") return fail("wrong_page", "Open www.doordash.com in this tab. Nothing was changed.");
    if (context?.signal?.aborted) return fail("cancelled", "Cancelled before any request.");
    const signals = [AbortSignal.timeout(25000)];
    if (context?.signal) signals.push(context.signal);
    const signal = AbortSignal.any(signals);
    const csrf = (document.cookie.split(";").map(c => c.trim()).find(c => c.startsWith("csrf_token=")) || "").slice(11);
    const request = async (operationName, query, variables) => {
      if (signal.aborted) throw fail("cancelled", "Cancelled before the request.");
      let r, raw;
      try {
        r = await fetch("/graphql/" + operationName + "?operation=" + operationName, { method: "POST", credentials: "include", signal, headers: { "content-type": "application/json", "x-csrftoken": csrf, "x-channel-id": "marketplace", "x-experience-id": "doordash" }, body: JSON.stringify({ operationName, variables, query }) });
        raw = await r.text();
      } catch { throw fail("site_error", "DoorDash did not answer or the read was cancelled."); }
      if (r.status === 401) throw fail("login_required", "Sign in to the intended DoorDash account manually.");
      if (r.status === 429) throw fail("rate_limited", "DoorDash is rate limiting this session. Do not retry automatically.");
      if (r.status === 403) throw fail("blocked", "DoorDash denied this request. Resolve access manually; do not bypass or retry automatically.");
      if (new TextEncoder().encode(raw).byteLength > 2000000) throw fail("site_changed", "DoorDash returned an oversized response.");
      let j;
      try { j = JSON.parse(raw); } catch { throw fail("blocked", "DoorDash returned a non-JSON page, possibly a challenge. Resolve it manually."); }
      if (j.errors?.length) {
        const codes = j.errors.map(e => String(e?.extensions?.code || "")).join(" ");
        const kind = /UNAUTHENTICATED|UNAUTHORIZED/.test(codes) ? "login_required" : /PERMISSION_DENIED|FORBIDDEN/.test(codes) ? "blocked" : /RATE_LIMIT/.test(codes) ? "rate_limited" : "site_changed";
        throw fail(kind, "DoorDash rejected the query. No private server error text is returned.");
      }
      if (!r.ok || !j.data || typeof j.data !== "object") throw fail("site_changed", "DoorDash's response is incomplete.");
      return j.data;
    };
    const accountQuery = "query consumerBucketing { consumer { email isGuest defaultAddress { city state zipCode countryCode } } }";
    const cartQuery = "query listDetailedCarts($input: ListDetailedCartsInput!) { listDetailedCarts(input: $input) { detailedCarts { cart { id groupCart isBundle isCatering isMerchantShipping isPrescriptionDelivery isConsumerPickup currencyCode subtotal total restaurant { id name } orders { id isSubCartFinalized orderItems { id quantity singlePrice priceOfTotalQuantity priceDisplayString cartItemStatusType nestedOptions specialInstructions continuousQuantity purchaseType isPrescriptionItem options { id name quantity price } item { id name storeId } } lineItems { label finalMoney { unitAmount displayString } } } } } } }";
    const text = (v, n = 200) => typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null;
    const ident = v => (typeof v === "string" || Number.isSafeInteger(v)) && /^[A-Za-z0-9_-]{1,64}$/.test(String(v)) ? String(v) : null;
    const integer = v => Number.isSafeInteger(v) ? v : null;
    const bool = v => typeof v === "boolean" ? v : null;
    const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
    const revision = async c => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(c)))))].map(b => b.toString(16).padStart(2, "0")).join("");
    const readAccount = async () => {
      const data = await request("consumerBucketing", accountQuery, {});
      const c = data.consumer;
      if (!c || c.isGuest === true || !text(c.email)) throw fail("login_required", "A non-guest signed-in account is required. Sign in manually.");
      if (c.isGuest !== false) throw fail("site_changed", "DoorDash did not confirm the account type.");
      if (c.email.trim().toLowerCase() !== input.expected_account_email.toLowerCase()) throw fail("wrong_account", "This browser is signed in to a different account. Nothing was changed.");
      return c;
    };
    const readCarts = async () => {
      const data = await request("listDetailedCarts", cartQuery, { input: {} });
      const list = data.listDetailedCarts?.detailedCarts;
      if (!Array.isArray(list)) throw fail("site_changed", "DoorDash did not return its open-cart list.");
      return list.map(d => d?.cart);
    };
    const project = async c => {
      if (!c || !ident(c.id) || !Array.isArray(c.orders) || c.orders.some(o => !o || !Array.isArray(o.orderItems))) throw fail("site_changed", "An open cart has an unsupported shape.");
      const rawLines = c.orders.flatMap(o => o.orderItems);
      if (rawLines.some(l => !l || !ident(l.id))) throw fail("site_changed", "A cart line has no usable id.");
      const rawFees = c.orders.flatMap(o => Array.isArray(o.lineItems) ? o.lineItems : []);
      return { cart_id: ident(c.id), store_id: ident(c.restaurant?.id), store_name: text(c.restaurant?.name), fulfillment_type: c.isConsumerPickup === true ? "pickup" : c.isConsumerPickup === false ? "delivery" : "unknown", group_cart: bool(c.groupCart), bundle: bool(c.isBundle), catering: bool(c.isCatering), merchant_shipping: bool(c.isMerchantShipping), currency: text(c.currencyCode, 10), subtotal_minor: integer(c.subtotal), total_minor: integer(c.total), lines: rawLines.slice(0, 100).map(l => ({ line_id: ident(l.id), item_id: ident(l.item?.id), name: text(l.item?.name), quantity: typeof l.quantity === "number" && Number.isFinite(l.quantity) ? l.quantity : null, unit_price_minor: integer(l.singlePrice), total_minor: integer(l.priceOfTotalQuantity), price_display: text(l.priceDisplayString), options: (Array.isArray(l.options) ? l.options : []).slice(0, 50).map(o => ({ option_id: ident(o?.id) || "unknown", name: text(o?.name), quantity: typeof o?.quantity === "number" && Number.isFinite(o.quantity) ? o.quantity : null, price_minor: integer(o?.price) })) })), fee_lines: rawFees.slice(0, 30).map(l => ({ label: text(l?.label), amount_minor: integer(l?.finalMoney?.unitAmount), display: text(l?.finalMoney?.displayString) })), revision: await revision(c), truncated: rawLines.length > 100 || rawFees.length > 30 || rawLines.some(l => Array.isArray(l.options) && l.options.length > 50) };
    };
    const deliveryContext = c => {
      const label = (document.querySelector("[data-testid='addressTextButton']")?.innerText || "").trim();
      const basis = label ? /^(?:your address|tu direcci[oó]n)$/i.test(label) ? "no_address_selected" : /\d/.test(label) ? "selected_address" : "unknown" : document.querySelector("[data-testid='LandingPageAddressSearch']") ? "no_address_selected" : "unknown";
      return { basis, default_address_region: { city: text(c.defaultAddress?.city), state: text(c.defaultAddress?.state), postal_code: text(c.defaultAddress?.zipCode), country_code: text(c.defaultAddress?.countryCode) }, note: "Basis describes the current header, not a verified cart delivery address. The region is the account's saved default, which may differ. No address is selected or changed. Totals and fees are provisional, not a payable quote." };
    };
    try {
      const account = await readAccount();
      const carts = await readCarts();
      const output = { status: "ok", account_matched: true, carts: await Promise.all(carts.slice(0, 20).map(project)), carts_truncated: carts.length > 20, delivery_context: deliveryContext(account) };
      if (new TextEncoder().encode(JSON.stringify(output)).byteLength > 180000) return fail("blocked", "The cart list exceeds the safe output limit; inspect the site manually.");
      return output;
    } catch (error) {
      return error?.status === "error" ? error : fail("site_changed", "DoorDash returned an unsupported cart or account shape. Nothing was changed.");
    }
  }
}]

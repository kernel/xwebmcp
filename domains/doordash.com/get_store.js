[{
  kind: "page",
  match: { url_patterns: ["https://www.doordash.com/*"] },
  tool: {
    name: "get_store",
    description: "Get one DoorDash (www.doordash.com) store by store_id (the id from search_restaurants or the number at the end of a doordash.com/store/<name>-<id>/ URL): name, cuisines, price level, rating, address and coordinates, timezone, whether it offers delivery, pickup, group orders, catering and scheduling, open-hours schedules, its menus (menu_id is the menuId that the site's own add_to_cart tool needs), and whether delivery and pickup can be ordered right now with an estimate range and the site's delivery-fee text. Delivery availability, estimate and distance are computed by DoorDash for the delivery address selected in this browser session, not for the store alone, so delivery_context.basis states which case applies: selected_address (figures are for that address), no_address_selected (the figures DoorDash returns then describe a placeholder location, not the customer, and every store reads 'Too far away', so delivery.available, its reason and estimate, distance and too_far_from_consumer are withheld as null), or unknown (the page has no header address control, as on the signed-out landing page and /home; figures are passed through unverified, so open a store, search or DashPass page first for a definite basis). signed_in says whether the account is signed in. This tool never selects or changes an address and never returns address text. It does not return menu items (use the site's get_restaurant_menu on the store page), reviews, or a fee quote: the fee text depends on the address, the account's benefits and the basket. Convenience and grocery stores return their header details with menu null. Read-only; works signed out; runs from any www.doordash.com page without navigating.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["store_id"],
      properties: {
        store_id: { type: "string", pattern: "^[0-9]{1,12}$", description: "DoorDash store id, digits only, e.g. the id field returned by search_restaurants." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "store_id", "name", "url", "store_type", "description", "cuisines", "price_range", "rating", "address", "timezone", "offers", "operation_status", "operation_text", "hours", "delivery", "pickup", "delivery_context", "menu"],
          properties: {
            status: { const: "ok" },
            store_id: { type: "string", pattern: "^[0-9]{1,12}$" },
            name: { type: "string", minLength: 1 },
            url: { type: "string", pattern: "^https://www\\.doordash\\.com/(convenience/)?store/[0-9]+/$", description: "Canonical store URL; the site redirects it to the slugged form." },
            store_type: { enum: ["restaurant", "convenience"], description: "convenience covers grocery and retail stores, whose catalog is not a menu." },
            description: { type: ["string", "null"] },
            cuisines: { type: "array", maxItems: 10, items: { type: "string" }, description: "The site's business tags, e.g. Italian, Pizza." },
            price_range: {
              type: "object", additionalProperties: false, required: ["level", "text"],
              properties: { level: { type: ["integer", "null"], minimum: 1, maximum: 4 }, text: { type: ["string", "null"], description: "$ to $$$$ as the site shows it." } }
            },
            rating: {
              type: "object", additionalProperties: false, required: ["average", "count", "count_text", "is_new"],
              properties: { average: { type: ["number", "null"] }, count: { type: ["integer", "null"] }, count_text: { type: ["string", "null"], description: "For example (9k+)." }, is_new: { type: ["boolean", "null"] } }
            },
            address: {
              type: "object", additionalProperties: false, required: ["street", "city", "state", "latitude", "longitude"],
              description: "The store's own address, not the customer's.",
              properties: { street: { type: ["string", "null"] }, city: { type: ["string", "null"] }, state: { type: ["string", "null"] }, latitude: { type: ["number", "null"] }, longitude: { type: ["number", "null"] } }
            },
            timezone: { type: ["string", "null"] },
            offers: {
              type: "object", additionalProperties: false, required: ["delivery", "pickup", "group_order", "catering", "scheduling", "dashpass_partner"],
              description: "Which services the store supports in general; not whether they can be ordered right now (see delivery and pickup).",
              properties: {
                delivery: { type: ["boolean", "null"] }, pickup: { type: ["boolean", "null"] }, group_order: { type: ["boolean", "null"] },
                catering: { type: ["boolean", "null"] }, scheduling: { type: ["boolean", "null"] }, dashpass_partner: { type: ["boolean", "null"] }
              }
            },
            operation_status: { type: ["string", "null"], description: "The site's operating status for DoorDash orders, e.g. OPEN. Pass-through; other values are not enumerated." },
            operation_text: { type: ["string", "null"], description: "For example: Accepting DoorDash orders until 2:40 AM." },
            hours: {
              type: "object", additionalProperties: false, required: ["store", "doordash_orders"],
              properties: {
                store: { type: "array", maxItems: 7, items: { type: "object", additionalProperties: false, required: ["day", "slots"], properties: { day: { type: "string" }, slots: { type: "array", maxItems: 6, items: { type: "string" }, description: "Open periods as the site prints them, e.g. 10 AM - 2:40 AM." } } }, description: "The store's own hours of operation." },
                doordash_orders: { type: "array", maxItems: 7, items: { type: "object", additionalProperties: false, required: ["day", "slots"], properties: { day: { type: "string" }, slots: { type: "array", maxItems: 6, items: { type: "string" }, description: "Open periods as the site prints them, e.g. 10 AM - 2:40 AM." } } }, description: "The hours in which the store accepts DoorDash orders." }
              }
            },
            delivery: {
              type: "object", additionalProperties: false, required: ["available", "unavailable_reason", "unavailable_message", "estimate_minutes", "fee_display"],
              description: "Delivery to the session's delivery context (see delivery_context).",
              properties: {
                available: { type: ["boolean", "null"], description: "True when DoorDash reports delivery can be ordered now to the selected address. Null when no address is selected (delivery_context.basis no_address_selected) or the site did not say." },
                unavailable_reason: { type: ["string", "null"], description: "The site's reason when not available, e.g. Too far away. Null when withheld." },
                unavailable_message: { type: ["string", "null"], description: "Null when withheld." },
                estimate_minutes: { type: ["string", "null"], description: "The site's estimate range, e.g. 27 - 37. Null unless delivery is available: the site sends a range even for unavailable delivery." },
                fee_display: {
                  type: "object", additionalProperties: false, required: ["title", "subtitle", "text", "is_surging"],
                  description: "DoorDash's own delivery-fee strings, unparsed. Not a quote: they depend on the address, account benefits and basket.",
                  properties: { title: { type: ["string", "null"] }, subtitle: { type: ["string", "null"] }, text: { type: ["string", "null"] }, is_surging: { type: ["boolean", "null"] } }
                }
              }
            },
            pickup: {
              type: "object", additionalProperties: false, required: ["available", "unavailable_reason", "estimate_minutes"],
              properties: {
                available: { type: ["boolean", "null"], description: "True when DoorDash reports pickup can be ordered now." },
                unavailable_reason: { type: ["string", "null"] },
                estimate_minutes: { type: ["string", "null"], description: "Null unless pickup is available." }
              }
            },
            delivery_context: {
              type: "object", additionalProperties: false, required: ["basis", "address_selected", "signed_in", "distance", "too_far_from_consumer", "note"],
              properties: {
                basis: { enum: ["selected_address", "no_address_selected", "unknown"], description: "What the delivery figures describe. selected_address: the address chosen in this browser. no_address_selected: DoorDash used a placeholder location, so delivery available, reason, estimate, distance and too_far_from_consumer are withheld (null). unknown: this page has no header address control; the figures are passed through unverified." },
                address_selected: { type: ["boolean", "null"], description: "True when this document's header shows a delivery address, false when it shows the site's 'Your Address' placeholder, null when this page has no header address control. The address text is never returned." },
                signed_in: { type: "boolean", description: "From the dd_cx_logged_in cookie; a hint only. Fees and promotions can differ by account." },
                distance: {
                  anyOf: [{ type: "null" }, {
                    type: "object", additionalProperties: false, required: ["value", "unit"],
                    properties: { value: { type: "number" }, unit: { type: "string" } }
                  }],
                  description: "Distance from the location DoorDash used to the store. Null when withheld (no address selected)."
                },
                too_far_from_consumer: { type: ["boolean", "null"], description: "DoorDash's own flag that the store is outside delivery range of that location. Null when withheld." },
                note: { type: "string" }
              }
            },
            menu: {
              anyOf: [{ type: "null" }, {
                type: "object", additionalProperties: false, required: ["menu_id", "name", "display_hours", "menus", "menus_truncated"],
                properties: {
                  menu_id: { type: ["string", "null"], description: "The default menu id; pass it as menuId to the site's add_to_cart tool." },
                  name: { type: ["string", "null"] },
                  display_hours: { type: ["string", "null"] },
                  menus: {
                    type: "array", maxItems: 20,
                    items: {
                      type: "object", additionalProperties: false, required: ["menu_id", "name", "display_hours"],
                      properties: { menu_id: { type: "string" }, name: { type: ["string", "null"] }, display_hours: { type: ["string", "null"] } }
                    },
                    description: "Every menu the store offers (for example All Day, Lunch), each usable as menuId."
                  },
                  menus_truncated: { type: "boolean", description: "True when the store lists more than 20 menus." }
                }
              }],
              description: "Null for convenience stores."
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "not_found", "login_required", "challenge", "rate_limited", "site_changed", "site_error"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, untrustedContentHint: true }
  },
  execute: async (input, context) => {
    const ORIGIN = "https://www.doordash.com";
    const QUERY = "query storepageFeed($storeId: ID!, $fulfillmentType: FulfillmentType, $isMerchantPreview: Boolean, $entryPoint: StoreEntryPoint) { storepageFeed(storeId: $storeId, fulfillmentType: $fulfillmentType, isMerchantPreview: $isMerchantPreview, entryPoint: $entryPoint) { storeHeader { id name description timezone priceRange priceRangeDisplayString offersDelivery offersPickup offersGroupOrder offersCatering offersScheduling isConvenience isDashpassPartner address { lat lng city state street } businessTags { name } ratings { numRatings numRatingsDisplayString averageRating isNewlyAdded } distanceFromConsumer { value label } deliveryFeeLayout { title subtitle isSurging displayDeliveryFee } asapStatus { displayUnavailableReason { title } } status { delivery { isAvailable minutes unavailableReason isTooFarFromConsumer } pickup { isAvailable minutes unavailableReason } } } mxInfo { operationInfo { operationStatusInfo { description operationStatus } storeOperationHourInfo { operationSchedule { dayOfWeek timeSlotList } } doordashOperationHourInfo { operationSchedule { dayOfWeek timeSlotList } } } } menuBook { id name displayOpenHours menuList { id name displayOpenHours } } } }";
    const NOTE = "Delivery availability, estimates and distance are computed by DoorDash for the delivery address selected in this browser session. With no address selected they describe a placeholder location, not the customer, and are withheld. This tool never changes the address.";
    const CHALLENGE = /just a moment|challenge-platform|cf-chl|captcha|turnstile|verify (?:that )?you(?:'re| are) (?:a )?human|access denied|px-captcha/i;
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const text = (value, max = 300) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
    const id = value => (typeof value === "string" || typeof value === "number") && String(value).trim() ? String(value).trim().slice(0, 30) : null;
    const bool = value => typeof value === "boolean" ? value : null;
    const number = value => typeof value === "number" && isFinite(value) ? value : (typeof value === "string" && value.trim() && isFinite(Number(value)) ? Number(value) : null);
    const days = info => {
      const schedule = info && Array.isArray(info.operationSchedule) ? info.operationSchedule : [];
      return schedule.filter(d => d && text(d.dayOfWeek, 20)).slice(0, 7).map(d => ({
        day: text(d.dayOfWeek, 20),
        slots: (Array.isArray(d.timeSlotList) ? d.timeSlotList : []).map(s => text(s, 60)).filter(Boolean).slice(0, 6)
      }));
    };

    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "store_id") || typeof input.store_id !== "string" || !/^[0-9]{1,12}$/.test(input.store_id)) {
      return fail("invalid_input", "store_id must be a string of 1 to 12 digits and is the only accepted field. No request was made.");
    }
    if (location.origin !== ORIGIN) return fail("wrong_page", "Open a https://www.doordash.com/ page in this tab, then call again. Nothing was changed.");
    const storeId = input.store_id;
    const csrf = (document.cookie.split(";").map(c => c.trim()).find(c => c.startsWith("csrf_token=")) || "").slice("csrf_token=".length);
    const signals = [AbortSignal.timeout(25000)];
    if (context && context.signal) signals.push(context.signal);

    let response;
    let body;
    try {
      response = await fetch("/graphql/storepageFeed?operation=storepageFeed", {
        method: "POST", credentials: "include", signal: AbortSignal.any(signals),
        headers: { "content-type": "application/json", accept: "*/*", "x-csrftoken": csrf, "x-channel-id": "marketplace", "x-experience-id": "doordash" },
        body: JSON.stringify({
          operationName: "storepageFeed",
          variables: { storeId, fulfillmentType: "Delivery", isMerchantPreview: false, entryPoint: "External" },
          query: QUERY
        })
      });
      body = await response.text();
    } catch (error) {
      return fail("site_error", (error && error.name === "TimeoutError" ? "DoorDash did not answer within 25 seconds." : "The request to DoorDash failed or was cancelled.") + " Nothing was changed.");
    }
    if (response.status === 429) return fail("rate_limited", "DoorDash is rate limiting requests from this browser; wait before calling again and do not retry automatically.");
    if (response.status === 401) return fail("login_required", "DoorDash refused the request as unauthenticated (HTTP 401). Sign in to DoorDash in this browser and call again.");
    let json = null;
    try { json = JSON.parse(body); } catch { /* not JSON */ }
    if (!json) {
      if (CHALLENGE.test(body.slice(0, 4000))) return fail("challenge", "DoorDash is showing a bot check in this browser (HTTP " + response.status + "). A person has to pass it on doordash.com; do not retry automatically.");
      return fail("site_error", "DoorDash answered with HTTP " + response.status + " and a response that is not JSON.");
    }
    if (Array.isArray(json.errors) && json.errors.length) {
      const errors = json.errors.map(e => (e && typeof e.message === "string" ? e.message : "") + " " + ((e && e.extensions && e.extensions.code) || ""));
      const joined = errors.join(" | ");
      if (/not_found|no stores returned/i.test(joined)) return fail("not_found", "DoorDash has no store with id " + storeId + ".");
      if (/unauthenticated|unauthorized|not logged in|login required/i.test(joined)) return fail("login_required", "DoorDash requires a signed-in account for this request. Sign in in this browser and call again.");
      if (/graphql_validation_failed|cannot query field|unknown (?:type|argument)|bad_user_input|variable "/i.test(joined)) return fail("site_changed", "DoorDash rejected the store query as invalid, so its schema has probably changed: " + joined.slice(0, 200));
      return fail("site_error", "DoorDash returned an error for this store: " + joined.slice(0, 200));
    }
    if (!response.ok) return fail("site_error", "DoorDash answered with HTTP " + response.status + ".");
    const feed = json.data && json.data.storepageFeed;
    const header = feed && feed.storeHeader;
    if (!header || typeof header !== "object") return fail("site_changed", "DoorDash's answer has no store header, so its response format has probably changed.");
    if (!text(header.name)) return fail("not_found", "DoorDash returned an empty store for id " + storeId + ".");
    if (header.id !== undefined && header.id !== null && String(header.id) !== storeId) return fail("site_changed", "DoorDash answered with a different store than requested.");

    const operation = feed.mxInfo && feed.mxInfo.operationInfo || {};
    const status = header.status || {};
    const delivery = status.delivery || {};
    const pickup = status.pickup || {};
    const fee = header.deliveryFeeLayout || {};
    const convenience = header.isConvenience === true;
    const menuBook = convenience ? null : feed.menuBook;
    const menuList = menuBook && Array.isArray(menuBook.menuList) ? menuBook.menuList.filter(m => m && id(m.id)) : [];
    const distance = header.distanceFromConsumer;
    const addressButton = document.querySelector("[data-testid='addressTextButton']");
    const addressText = addressButton ? (addressButton.innerText || "").trim() : "";
    const addressSelected = addressText ? addressText !== "Your Address" : null;
    // With no address selected DoorDash answers for a placeholder location, so its delivery figures are withheld.
    const withheld = addressSelected === false;
    const storeAddress = header.address || {};

    return {
      status: "ok",
      store_id: storeId,
      name: text(header.name, 200),
      url: ORIGIN + (convenience ? "/convenience" : "") + "/store/" + storeId + "/",
      store_type: convenience ? "convenience" : "restaurant",
      description: text(header.description),
      cuisines: (Array.isArray(header.businessTags) ? header.businessTags : []).map(t => text(t && t.name, 60)).filter(Boolean).slice(0, 10),
      price_range: { level: Number.isInteger(header.priceRange) && header.priceRange >= 1 && header.priceRange <= 4 ? header.priceRange : null, text: text(header.priceRangeDisplayString, 10) },
      rating: {
        average: number(header.ratings && header.ratings.averageRating),
        count: Number.isInteger(header.ratings && header.ratings.numRatings) ? header.ratings.numRatings : null,
        count_text: text(header.ratings && header.ratings.numRatingsDisplayString, 30),
        is_new: bool(header.ratings && header.ratings.isNewlyAdded)
      },
      address: { street: text(storeAddress.street, 200), city: text(storeAddress.city, 100), state: text(storeAddress.state, 50), latitude: number(storeAddress.lat), longitude: number(storeAddress.lng) },
      timezone: text(header.timezone, 60),
      offers: {
        delivery: bool(header.offersDelivery), pickup: bool(header.offersPickup), group_order: bool(header.offersGroupOrder),
        catering: bool(header.offersCatering), scheduling: bool(header.offersScheduling), dashpass_partner: bool(header.isDashpassPartner)
      },
      operation_status: text(operation.operationStatusInfo && operation.operationStatusInfo.operationStatus, 40),
      operation_text: text(operation.operationStatusInfo && operation.operationStatusInfo.description),
      hours: { store: days(operation.storeOperationHourInfo), doordash_orders: days(operation.doordashOperationHourInfo) },
      delivery: {
        available: withheld ? null : bool(delivery.isAvailable),
        unavailable_reason: withheld ? null : text(delivery.unavailableReason, 100),
        unavailable_message: withheld ? null : text(header.asapStatus && header.asapStatus.displayUnavailableReason && header.asapStatus.displayUnavailableReason.title),
        estimate_minutes: !withheld && delivery.isAvailable === true ? text(delivery.minutes, 30) : null,
        fee_display: { title: text(fee.title, 100), subtitle: text(fee.subtitle, 100), text: text(fee.displayDeliveryFee, 100), is_surging: bool(fee.isSurging) }
      },
      pickup: {
        available: bool(pickup.isAvailable),
        unavailable_reason: text(pickup.unavailableReason, 100),
        estimate_minutes: pickup.isAvailable === true ? text(pickup.minutes, 30) : null
      },
      delivery_context: {
        basis: addressSelected === true ? "selected_address" : withheld ? "no_address_selected" : "unknown",
        address_selected: addressSelected,
        signed_in: /(?:^|;\s*)dd_cx_logged_in=true(?:;|$)/.test(document.cookie),
        distance: !withheld && distance && number(distance.value) !== null && text(distance.label, 10) ? { value: number(distance.value), unit: text(distance.label, 10) } : null,
        too_far_from_consumer: withheld ? null : bool(delivery.isTooFarFromConsumer),
        note: NOTE
      },
      menu: menuBook ? {
        menu_id: id(menuBook.id),
        name: text(menuBook.name, 100),
        display_hours: text(menuBook.displayOpenHours, 60),
        menus: menuList.slice(0, 20).map(m => ({ menu_id: id(m.id), name: text(m.name, 100), display_hours: text(m.displayOpenHours, 60) })),
        menus_truncated: menuList.length > 20
      } : null
    };
  }
}]

[{
  kind: "page",
  match: { url_patterns: ["https://www.doordash.com/*"] },
  tool: {
    name: "set_delivery_address",
    description: "Set the delivery address of a signed-out DoorDash visit, as the header's address picker does: it looks the address up in DoorDash's address autocomplete, chooses the suggestion you name (the first by default, as the picker lists them) and makes it the visit's delivery address with the same requests the picker sends. Success is confirmed by DoorDash's answer, which states the address it now delivers to and must have the chosen suggestion's city and ZIP code. Store fees, delivery estimates, search results and get_store then use that address, but pages already open keep showing the old one until they load again: the site itself opens /home after an address is chosen, so navigate before reading, then list the tools again. Returns the suggestions when none matches the request or the chosen number is out of range; never edits saved account addresses: it asks DoorDash whether the visit is signed out before changing anything and refuses when it is not (use save_address then). Only call it with an address the user gave.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["address"],
      properties: {
        address: { type: "string", minLength: 3, maxLength: 200, description: "The address as you would type it into the picker, e.g. 'Times Square, New York, NY 10036'." },
        suggestion: { type: "integer", minimum: 1, maximum: 10, default: 1, description: "Which autocomplete suggestion to choose, counting from 1 in the order DoorDash lists them; returned suggestions show that order." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "address", "suggestions", "next_step"],
          properties: {
            status: { const: "ok" },
            address: {
              type: "object", additionalProperties: false, required: ["printable", "street", "city", "state", "zip_code", "submarket"],
              description: "The delivery address as DoorDash now reports it for this visit.",
              properties: {
                printable: { type: "string", maxLength: 200 }, street: { type: ["string", "null"], maxLength: 200 }, city: { type: ["string", "null"], maxLength: 200 }, state: { type: ["string", "null"], maxLength: 20 },
                zip_code: { type: ["string", "null"], maxLength: 20 }, submarket: { type: ["string", "null"], maxLength: 200 }
              }
            },
            suggestions: { type: "array", maxItems: 10, items: { type: "string", maxLength: 200 }, description: "Every suggestion the autocomplete offered, in its order." },
            next_step: { type: "string", maxLength: 500 }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message", "suggestions"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "signed_in", "address_not_found", "address_mismatch", "rate_limited", "site_changed", "site_error"] },
            error_message: { type: "string", maxLength: 500 },
            suggestions: { type: "array", maxItems: 10, items: { type: "string", maxLength: 200 } }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, untrustedContentHint: true }
  },
  execute: async (input, context) => {
    const ORIGIN = "https://www.doordash.com";
    const MUTATION = "mutation addConsumerAddressV2($lat: Float!, $lng: Float!, $city: String!, $state: String!, $zipCode: String!, $printableAddress: String!, $shortname: String!, $googlePlaceId: String!, $addressId: String) {\n  addConsumerAddressV2(\n    lat: $lat\n    lng: $lng\n    city: $city\n    state: $state\n    zipCode: $zipCode\n    printableAddress: $printableAddress\n    shortname: $shortname\n    googlePlaceId: $googlePlaceId\n    addressId: $addressId\n  ) {\n    defaultAddress {\n      id\n      street\n      city\n      state\n      zipCode\n      printableAddress\n      submarket\n      __typename\n    }\n    isGuest\n    __typename\n  }\n}\n";
    const fail = (kind, message, suggestions = []) => ({ status: "error", error_kind: kind, error_message: message, suggestions });
    const text = (value, max = 200) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "address" && k !== "suggestion")) return fail("invalid_input", "Only address and suggestion are accepted. Nothing was changed.");
    const address = typeof input.address === "string" ? input.address.trim().replace(/\s+/g, " ") : "";
    if (address.length < 3 || address.length > 200) return fail("invalid_input", "address must be 3 to 200 characters. Nothing was changed.");
    const choice = input.suggestion === undefined ? 1 : input.suggestion;
    if (!Number.isInteger(choice) || choice < 1 || choice > 10) return fail("invalid_input", "suggestion must be an integer from 1 to 10. Nothing was changed.");
    if (location.origin !== ORIGIN) return fail("wrong_page", "Open a https://www.doordash.com/ page in this tab, then call again. Nothing was changed.");
    if (/(?:^|;\s*)dd_cx_logged_in=true(?:;|$)/.test(document.cookie)) return fail("signed_in", "This browser is signed in to DoorDash, where choosing an address saves it to the account; use save_address instead. Nothing was changed.");

    const signals = [AbortSignal.timeout(25000)];
    if (context && context.signal) signals.push(context.signal);
    const signal = AbortSignal.any(signals);
    const csrf = (document.cookie.split(";").map(c => c.trim()).find(c => c.startsWith("csrf_token=")) || "").slice("csrf_token=".length);
    const graphql = { "content-type": "application/json", accept: "*/*", "x-csrftoken": csrf, "x-channel-id": "marketplace", "x-experience-id": "doordash" };
    const gateway = { accept: "application/json", "x-experience-id": "doordash", "x-unified-gateway-generated-source": "v1" };
    const call = async (path, init) => {
      let response, body;
      try {
        response = await fetch(path, { credentials: "include", signal, ...init });
        body = await response.text();
      } catch (error) {
        return { error: error && error.name === "TimeoutError" ? "DoorDash did not answer within 25 seconds." : "The request to DoorDash failed or was cancelled." };
      }
      if (response.status === 429) return { status: 429 };
      let json = null;
      try { json = JSON.parse(body); } catch { /* not JSON */ }
      return { status: response.status, json };
    };

    // The cookie can be missing on a signed-in visit, and for an account the mutation below saves the address there.
    const visitor = await call("/graphql/consumerBucketing?operation=consumerBucketing", {
      method: "POST", headers: graphql,
      body: JSON.stringify({ operationName: "consumerBucketing", variables: {}, query: "query consumerBucketing { consumer { isGuest } }" })
    });
    if (visitor.error) return fail("site_error", visitor.error + " Nothing was changed.");
    if (visitor.status === 429) return fail("rate_limited", "DoorDash is rate limiting requests from this browser; wait before calling again. Nothing was changed.");
    const isGuest = visitor.json && visitor.json.data && visitor.json.data.consumer ? visitor.json.data.consumer.isGuest : undefined;
    if (isGuest === false) return fail("signed_in", "This browser is signed in to DoorDash, where choosing an address saves it to the account; use save_address instead. Nothing was changed.");
    if (visitor.status !== 200 || isGuest !== true) return fail("site_changed", "DoorDash did not confirm this is a signed-out visit (HTTP " + visitor.status + "). Nothing was changed.");

    const found = await call("/unified-gateway/geo-intelligence/v2/address/autocomplete?input_address=" + encodeURIComponent(address), { headers: gateway });
    if (found.error) return fail("site_error", found.error + " Nothing was changed.");
    if (found.status === 429) return fail("rate_limited", "DoorDash is rate limiting requests from this browser; wait before calling again. Nothing was changed.");
    if (found.status !== 200 || !found.json || !Array.isArray(found.json.predictions)) return fail("site_changed", "DoorDash's address autocomplete answered HTTP " + found.status + " without its predictions list. Nothing was changed.");
    const predictions = found.json.predictions.filter(p => p && text(p.formatted_address) && text(p.source_place_id, 500)).slice(0, 10);
    const suggestions = predictions.map(p => text(p.formatted_address));
    if (!predictions.length) return fail("address_not_found", "DoorDash's address autocomplete has no suggestion for '" + address.slice(0, 80) + "'. Try a street address with city and ZIP. Nothing was changed.");
    if (choice > predictions.length) return fail("address_not_found", "DoorDash offered " + predictions.length + " suggestion(s), so there is no suggestion " + choice + ". Nothing was changed.", suggestions);
    const picked = predictions[choice - 1];

    const created = await call("/unified-gateway/geo-intelligence/v2/address/get-or-create", {
      method: "POST", headers: { ...gateway, "content-type": "application/json" },
      body: JSON.stringify({ address_identifier: { _type: "source_place_id_request", source_place_id: picked.source_place_id } })
    });
    if (created.error) return fail("site_error", created.error + " Nothing was changed.", suggestions);
    if (created.status === 429) return fail("rate_limited", "DoorDash is rate limiting requests from this browser; wait before calling again. Nothing was changed.", suggestions);
    const place = created.json && created.json.address;
    const lat = place && Number(place.lat), lng = place && Number(place.lng);
    if (created.status !== 200 || !place || !text(place.id, 40) || !text(place.source_place_id, 200) || !isFinite(lat) || !isFinite(lng) || !text(place.locality) || !text(place.administrative_area_level1) || !text(place.postal_code)) {
      return fail("site_changed", "DoorDash did not resolve the chosen suggestion to an address (HTTP " + created.status + "). Nothing was changed.", suggestions);
    }
    const segments = Array.isArray(place.formatted_address_segmented) ? place.formatted_address_segmented : [];
    const shortname = text(place.formatted_address_short) || text(place.street_address) || text(segments[0]);
    const printable = text(segments[1]) || text(place.formatted_address);

    const saved = await call("/graphql/addConsumerAddressV2?operation=addConsumerAddressV2", {
      method: "POST",
      headers: graphql,
      body: JSON.stringify({
        operationName: "addConsumerAddressV2",
        variables: { googlePlaceId: place.source_place_id, printableAddress: printable, lat, lng, city: place.locality, state: place.administrative_area_level1, zipCode: place.postal_code, shortname, addressId: String(place.id) },
        query: MUTATION
      })
    });
    if (saved.error) return fail("site_error", saved.error + " The address may or may not have been set; reload the page and check the header before calling again.", suggestions);
    if (saved.status === 429) return fail("rate_limited", "DoorDash is rate limiting requests from this browser; wait before calling again. The address was not confirmed.", suggestions);
    const result = saved.json && saved.json.data && saved.json.data.addConsumerAddressV2;
    const current = result && result.defaultAddress;
    if (saved.status !== 200 || !current || !text(current.printableAddress) || (saved.json.errors && saved.json.errors.length)) {
      return fail("site_error", "DoorDash did not confirm the address (HTTP " + saved.status + "). Reload the page and check the header before calling again.", suggestions);
    }
    if (result.isGuest === false) return fail("signed_in", "DoorDash answered for a signed-in account, so the address may now be saved there; check the account's addresses. Use save_address for signed-in visits.", suggestions);
    const same = (a, b) => typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
    if (!same(current.zipCode, place.postal_code) || !same(current.city, place.locality)) {
      return fail("address_mismatch", "DoorDash now reports '" + text(current.printableAddress, 120) + "' as the delivery address, not the chosen suggestion. Reload the page and check the header before calling again.", suggestions);
    }
    return {
      status: "ok",
      address: { printable: text(current.printableAddress), street: text(current.street), city: text(current.city), state: text(current.state, 20), zip_code: text(current.zipCode, 20), submarket: text(current.submarket) },
      suggestions,
      next_step: "Navigate (for example to https://www.doordash.com/home, where the site goes after an address is chosen, or to a search page), then list the tools again; pages already open still show the previous address."
    };
  }
}]

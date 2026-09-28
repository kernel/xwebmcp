[{
  kind: "page",
  match: { url_patterns: ["https://instacart.com/*", "https://*.instacart.com/*"] },
  tool: {
    name: "get_delivery_address",
    description: "Read the Instacart delivery address this session is shopping for, and every address saved on the account. The selected address decides which store locations, catalogs, item ids and carts the other instacart.com tools use, so check it before searching or adding to a cart. Read-only. Runs on an open instacart.com page with a logged-in session. Pass an address_id from this list to set_delivery_address to switch.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "selected_address_id", "selected_address", "location", "addresses"],
          properties: {
            status: { const: "ok" },
            selected_address_id: { type: ["string", "null"], description: "The address the session is shopping for; null when the session only has a postal-code location." },
            selected_address: { oneOf: [{ type: "object", additionalProperties: false, required: ["address_id", "street_address", "apartment", "business_name", "line_one", "line_two", "postal_code", "is_selected"], properties: { address_id: { type: "string", description: "Pass to set_delivery_address." }, street_address: { type: ["string", "null"] }, apartment: { type: ["string", "null"] }, business_name: { type: ["string", "null"] }, line_one: { type: ["string", "null"], description: "First display line, e.g. the street." }, line_two: { type: ["string", "null"], description: "Second display line, e.g. \"Springfield, IL 62701\"." }, postal_code: { type: ["string", "null"] }, is_selected: { type: "boolean" } } }, { type: "null" }] },
            location: { type: "object", additionalProperties: false, required: ["postal_code", "zone_id"], properties: { postal_code: { type: "string" }, zone_id: { type: "string" } } },
            addresses: { type: "array", items: { type: "object", additionalProperties: false, required: ["address_id", "street_address", "apartment", "business_name", "line_one", "line_two", "postal_code", "is_selected"], properties: { address_id: { type: "string", description: "Pass to set_delivery_address." }, street_address: { type: ["string", "null"] }, apartment: { type: ["string", "null"] }, business_name: { type: ["string", "null"] }, line_one: { type: ["string", "null"], description: "First display line, e.g. the street." }, line_two: { type: ["string", "null"], description: "Second display line, e.g. \"Springfield, IL 62701\"." }, postal_code: { type: ["string", "null"] }, is_selected: { type: "boolean" } } } }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "not_logged_in", "location_unavailable", "site_changed", "throttled", "unknown"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const H = {
      UserAddresses: "22e6dfa5cb0c9e731bfb696f34f573c1c2e31b8191e96c2b14329c33400a0ddc",
      GetLastUserLocation: "6c76952dbbaf5fe8b79d2ae6dc96af8ccca133285868e7efb9a81ffe624e37e1"
    };
    const failure = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input)) return failure("invalid_input", "Input must be an object.");
    if (Object.keys(input).length) return failure("invalid_input", "This tool takes no input fields.");
    if (location.protocol !== "https:" || !(location.hostname === "instacart.com" || location.hostname.endsWith(".instacart.com"))) return failure("wrong_page", "Open an instacart.com page first.");
    const gql = async (op, variables) => {
      const url = new URL("/graphql", location.origin);
      url.searchParams.set("operationName", op);
      url.searchParams.set("variables", JSON.stringify(variables));
      url.searchParams.set("extensions", JSON.stringify({ persistedQuery: { version: 1, sha256Hash: H[op] } }));
      const response = await fetch(url, { headers: { "content-type": "application/json", "x-client-identifier": "web" }, credentials: "include" });
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      const code = body?.errors?.[0]?.extensions?.code || null;
      if (code === "PERSISTED_QUERY_NOT_SUPPORTED" || code === "PERSISTED_QUERY_NOT_FOUND") return { error: failure("site_changed", `Instacart no longer accepts the ${op} query this tool relies on; the tool needs updating.`) };
      if (response.status === 401 || response.status === 403 || code === "UNAUTHENTICATED") return { error: failure("not_logged_in", `Instacart rejected ${op} as unauthenticated; log in first.`) };
      if (response.status === 429) return { error: failure("throttled", `Instacart rate-limited ${op}; wait before retrying.`) };
      if (response.status >= 400 || !body || (body.errors && !body.data)) return { error: failure("unknown", `${op} failed with HTTP ${response.status}${body?.errors?.[0]?.message ? ": " + body.errors[0].message : ""}.`) };
      return { data: body.data };
    };
    try {
      const loc = await gql("GetLastUserLocation", {});
      if (loc.error) return loc.error;
      const last = loc.data?.lastUserLocation;
      if (!last || !last.postalCode || !last.zoneId) return failure("location_unavailable", "Instacart did not report a shopping location for this session; log in and choose an address first.");
      const list = await gql("UserAddresses", {});
      if (list.error) return list.error;
      if (!Array.isArray(list.data?.userAddresses)) return failure("site_changed", "Instacart's saved-address response no longer has the expected shape; the tool needs updating.");
      const selectedId = last.addressId ? String(last.addressId) : null;
      const addresses = list.data.userAddresses.filter(a => a && a.id).map(a => ({
        address_id: String(a.id),
        street_address: a.streetAddress || null,
        apartment: a.apartmentNumber || null,
        business_name: a.businessName || null,
        line_one: a.viewSection?.lineOneString ?? null,
        line_two: a.viewSection?.lineTwoString ?? null,
        postal_code: a.postalCode ?? null,
        is_selected: String(a.id) === selectedId
      }));
      if (!selectedId && !addresses.length) return failure("not_logged_in", "This session has no saved addresses; it is probably a guest session. Log in first.");
      return { status: "ok", selected_address_id: selectedId, selected_address: addresses.find(a => a.is_selected) || null, location: { postal_code: String(last.postalCode), zone_id: String(last.zoneId) }, addresses };
    } catch (error) {
      return failure("unknown", "Reading the address failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]

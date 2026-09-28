[{
  kind: "page",
  match: { url_patterns: ["https://instacart.com/*", "https://*.instacart.com/*"] },
  tool: {
    name: "set_delivery_address",
    description: "Switch the Instacart delivery address this session shops for to one of the account's saved addresses, through the site's UpdateUserLocation mutation (the same call the header address picker makes). Takes an address_id from get_delivery_address; does not create, edit or delete addresses. Changing the address changes which store locations serve the session, so store slugs, item ids and carts from earlier list_stores or search calls may no longer apply: call list_stores and search again afterwards. Sends at most one mutation and never retries; if the address is already selected nothing is sent. Pages that were already open keep showing the old address until reloaded. Runs on an open instacart.com page with a logged-in session.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["address_id"],
      properties: { address_id: { type: "string", pattern: "^[0-9]{1,30}$", description: "address_id from get_delivery_address." } }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "changed", "mutation_attempted", "previous_address_id", "selected_address_id", "line_one", "line_two", "location"],
          properties: {
            status: { const: "ok" },
            changed: { type: "boolean", description: "False when the address was already selected and nothing was sent." },
            mutation_attempted: { type: "boolean" },
            previous_address_id: { type: ["string", "null"] },
            selected_address_id: { type: "string", description: "The address Instacart confirmed as selected." },
            line_one: { type: ["string", "null"] },
            line_two: { type: ["string", "null"] },
            location: { type: "object", additionalProperties: false, required: ["postal_code", "zone_id"], properties: { postal_code: { type: "string" }, zone_id: { type: "string" } } }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "error_kind", "error_message", "mutation_attempted"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "not_logged_in", "location_unavailable", "address_not_found", "site_changed", "throttled", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            mutation_attempted: { type: "boolean", description: "True once the UpdateUserLocation mutation was sent, even if its outcome is unknown; check get_delivery_address before trying again." }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const H = {
      UserAddresses: "22e6dfa5cb0c9e731bfb696f34f573c1c2e31b8191e96c2b14329c33400a0ddc",
      GetLastUserLocation: "6c76952dbbaf5fe8b79d2ae6dc96af8ccca133285868e7efb9a81ffe624e37e1",
      UpdateUserLocation: "81bb02547c0f4aafe480a766600e75210e9087516e9891e0105a5ce3a622d845"
    };
    let sent = false;
    const failure = (kind, message) => ({ status: "error", error_kind: kind, error_message: message, mutation_attempted: sent });
    if (!input || typeof input !== "object" || Array.isArray(input)) return failure("invalid_input", "Input must be an object. Nothing was changed.");
    if (Object.keys(input).some(k => k !== "address_id")) return failure("invalid_input", "Unrecognized input field. Nothing was changed.");
    if (typeof input.address_id !== "string" || !/^[0-9]{1,30}$/.test(input.address_id)) return failure("invalid_input", "address_id must be the numeric id from get_delivery_address. Nothing was changed.");
    if (location.protocol !== "https:" || !(location.hostname === "instacart.com" || location.hostname.endsWith(".instacart.com"))) return failure("wrong_page", "Open an instacart.com page first. Nothing was changed.");
    const gql = async (op, variables, mutation = false) => {
      const headers = { "content-type": "application/json", "x-client-identifier": "web" };
      const extensions = { persistedQuery: { version: 1, sha256Hash: H[op] } };
      let response;
      if (mutation) {
        sent = true;
        response = await fetch("/graphql", { method: "POST", headers, credentials: "include", body: JSON.stringify({ operationName: op, variables, extensions }) });
      } else {
        const url = new URL("/graphql", location.origin);
        url.searchParams.set("operationName", op);
        url.searchParams.set("variables", JSON.stringify(variables));
        url.searchParams.set("extensions", JSON.stringify(extensions));
        response = await fetch(url, { headers, credentials: "include" });
      }
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      const code = body?.errors?.[0]?.extensions?.code || null;
      if (code === "PERSISTED_QUERY_NOT_SUPPORTED" || code === "PERSISTED_QUERY_NOT_FOUND") return { error: failure("site_changed", `Instacart no longer accepts the ${op} operation this tool relies on; the tool needs updating.`) };
      if (response.status === 401 || response.status === 403 || code === "UNAUTHENTICATED") return { error: failure("not_logged_in", `Instacart rejected ${op} as unauthenticated; log in first.`) };
      if (response.status === 429) return { error: failure("throttled", `Instacart rate-limited ${op}; wait before retrying.`) };
      if (response.status >= 400 || !body || (body.errors && !body.data)) return { error: failure("unknown", `${op} failed with HTTP ${response.status}${body?.errors?.[0]?.message ? ": " + body.errors[0].message : ""}.`) };
      return { data: body.data };
    };
    try {
      const loc = await gql("GetLastUserLocation", {});
      if (loc.error) return loc.error;
      const last = loc.data?.lastUserLocation;
      if (!last || !last.postalCode || !last.zoneId) return failure("location_unavailable", "Instacart did not report a shopping location for this session; log in first. Nothing was changed.");
      const list = await gql("UserAddresses", {});
      if (list.error) return list.error;
      if (!Array.isArray(list.data?.userAddresses)) return failure("site_changed", "Instacart's saved-address response no longer has the expected shape; the tool needs updating. Nothing was changed.");
      const target = list.data.userAddresses.find(a => a && String(a.id) === input.address_id);
      if (!target) return failure("address_not_found", `No saved address has id ${input.address_id}; call get_delivery_address for the ids. Nothing was changed.`);
      if (!target.postalCode) return failure("unknown", "The saved address has no postal code, which the site needs to select it. Nothing was changed.");
      const previous = last.addressId ? String(last.addressId) : null;
      const result = (confirmed, changed) => ({ status: "ok", changed, mutation_attempted: sent, previous_address_id: previous, selected_address_id: String(confirmed.addressId), line_one: target.viewSection?.lineOneString ?? target.streetAddress ?? null, line_two: target.viewSection?.lineTwoString ?? null, location: { postal_code: String(confirmed.postalCode), zone_id: String(confirmed.zoneId) } });
      if (previous === input.address_id) return result(last, false);
      const r = await gql("UpdateUserLocation", { addressId: input.address_id, postalCode: String(target.postalCode) }, true);
      if (r.error) return r.error;
      const confirmed = r.data?.updateUserLocation;
      if (!confirmed || String(confirmed.addressId) !== input.address_id || !confirmed.postalCode || !confirmed.zoneId) return failure("unknown", "Instacart did not confirm the new address; call get_delivery_address before trying again.");
      return result(confirmed, true);
    } catch (error) {
      return failure("unknown", "Switching the address failed" + (sent ? " after the request was sent" : "") + ": " + (error && error.message ? error.message : String(error)) + (sent ? "; call get_delivery_address before trying again." : ". Nothing was changed."));
    }
  }
}]

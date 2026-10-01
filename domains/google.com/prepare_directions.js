(() => {
  const text = { type: "string", minLength: 1, maxLength: 200 };
  const outputSchema = {
    type: "object", additionalProperties: false,
    required: ["status", "message", "origin", "destination", "directions_url", "navigation_performed"],
    properties: {
      status: { type: "string", enum: ["prepared", "invalid_input", "wrong_page", "canceled"] },
      message: { type: "string" }, origin: { type: ["string", "null"] }, destination: { type: ["string", "null"] },
      directions_url: { type: ["string", "null"] }, navigation_performed: { const: false }
    }
  };
  return [{
    kind: "page",
    match: { url_patterns: ["https://www.google.com/maps", "https://www.google.com/maps/*", "https://www.google.com/maps?*"] },
    tool: {
      name: "prepare_directions",
      description: "Prepare a Google Maps directions link between two explicit place names, addresses or coordinate strings. Returns the exact requested endpoints and a public link without opening it, resolving the places, requesting location, sending directions or starting navigation. Open the link yourself, check Maps' resolved endpoints and travel mode, then use get_directions to read the route options. No account is required and no route availability is promised.",
      inputSchema: { type: "object", additionalProperties: false, required: ["origin", "destination"], properties: { origin: text, destination: text } },
      outputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    execute: async (input, context = {}) => {
      const result = { status: "invalid_input", message: "", origin: null, destination: null, directions_url: null, navigation_performed: false };
      const fail = (status, message) => ({ ...result, status, message });
      const valid = value => typeof value === "string" && value.isWellFormed() && value.length <= 200 && /[\p{L}\p{N}]/u.test(value) && !/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["origin", "destination"].includes(k)) || !valid(input.origin) || !valid(input.destination)) return fail("invalid_input", "Supply origin and destination as explicit place names, addresses or coordinates (1-200 characters, no control or invisible characters).");
      const origin = input.origin.trim(), destination = input.destination.trim();
      if (origin.toLowerCase() === destination.toLowerCase()) return fail("invalid_input", "Origin and destination must differ.");
      if (context.signal?.aborted) return fail("canceled", "Preparation canceled.");
      if (location.hostname !== "www.google.com" || !(location.pathname === "/maps" || location.pathname.startsWith("/maps/"))) return fail("wrong_page", "Open https://www.google.com/maps?hl=en first.");
      return { ...result, status: "prepared", message: "Link prepared only; check resolved endpoints and mode in Maps before using the directions.", origin, destination, directions_url: `https://www.google.com/maps/dir/${encodeURIComponent(origin)}/${encodeURIComponent(destination)}/?hl=en` };
    }
  }];
})()

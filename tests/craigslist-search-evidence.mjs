export function summarizeSearchEvidence(body, output, http_status, request_count) {
  const type = value => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const data = body?.data, decode = data?.decode;
  const statuses = ["ok", "no_results", "error"];
  const errors = ["invalid_input", "wrong_page", "challenge", "login_required", "forbidden", "rate_limited", "site_changed", "site_error", "timeout", "canceled", "privacy_filtered", "outside_area"];
  return {
    http_status: count(http_status), request_count: count(request_count),
    api_version: count(body?.apiVersion), data_type: type(data),
    decode_present: data !== null && typeof data === "object" && Object.hasOwn(data, "decode"),
    decode_type: type(decode), decode_is_zero: decode === 0,
    decode_key_count: decode !== null && typeof decode === "object" && !Array.isArray(decode) ? Object.keys(decode).length : null,
    decode_version: count(decode?.version),
    items_count: Array.isArray(data?.items) ? data.items.length : null,
    total_result_count: count(data?.totalResultCount),
    category_matches: data?.categoryAbbr === "bia",
    locale_matches: data?.location?.country === "US" && data?.location?.url === "sfbay.craigslist.org",
    errors_type: type(body?.errors), errors_count: Array.isArray(body?.errors) ? body.errors.length : null,
    output_type: type(output),
    output_status: statuses.includes(output?.status) ? output.status : "unrecognized",
    output_error_kind: errors.includes(output?.error_kind) ? output.error_kind : null,
    output_site_total: count(output?.site_total),
    output_listings_count: Array.isArray(output?.listings) ? output.listings.length : null
  };
}

[{
  kind: "page",
  match: { url_patterns: ["https://www.amazon.com/*"] },
  tool: {
    name: "get_best_sellers",
    description: "Read Amazon US Best Sellers (www.amazon.com) as data: the ranked products of one department or category, with the categories you can open next. Call without category to list the top-level departments (no products); call with a category path from that list, such as 'kitchen' or 'kitchen/289913', to get its ranking, and pass the returned categories[].category values to go deeper or sideways. Each product has its Best Sellers rank and an asin to pass to get_product. Amazon's pages only include part of each ranking in the page itself: ranks 1-30 of the first page and 51-80 of the second (page 2); the rest load through page scripts and are not returned, so ranks are not contiguous. Read-only: it fetches the Best Sellers page from the current www.amazon.com document, never navigates the tab, and never touches a cart or an account. Prices follow the delivery location of this browser session, which the tool neither reads nor changes.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        category: { type: "string", pattern: "^[a-z0-9-]+(/[0-9]+)*$", maxLength: 80, description: "Category path from a previous response's categories[].category: a department such as 'kitchen', optionally followed by numeric category ids such as 'kitchen/289913'. Omit to list departments." },
        page: { type: "integer", minimum: 1, maximum: 2, default: 1, description: "1 or 2: the site's ranking has two pages of 50; only allowed together with category." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 30, description: "Maximum products to return from that page." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "category", "category_name", "page", "categories", "items"],
          properties: {
            status: { const: "ok" }, category: { type: ["string", "null"], description: "The category path requested; null for the department list." },
            category_name: { type: ["string", "null"] }, page: { type: "integer", minimum: 1, maximum: 2 },
            categories: {
              type: "array", maxItems: 60, description: "Categories the page links to, including the current category's parents and children. category null is 'Any Department' (the department list).",
              items: { type: "object", additionalProperties: false, required: ["name", "category"], properties: { name: { type: "string", minLength: 1 }, category: { type: ["string", "null"], pattern: "^[a-z0-9-]+(/[0-9]+)*$" } } }
            },
            items: {
              type: "array", maxItems: 50, description: "Empty when no category was requested.",
              items: {
                type: "object", additionalProperties: false, required: ["rank", "asin", "title", "url", "image_url", "price_cents", "price_text", "rating_average", "rating_count"],
                properties: {
                  rank: { type: "integer", minimum: 1, description: "The site's Best Sellers rank in this category; the list skips ranks that only load through page scripts." },
                  asin: { type: "string", pattern: "^[A-Z0-9]{10}$", description: "Pass to get_product." }, title: { type: "string", minLength: 1 },
                  url: { type: "string", description: "Canonical https://www.amazon.com/dp/<asin> address." }, image_url: { type: ["string", "null"] },
                  price_cents: { type: ["integer", "null"] }, price_text: { type: ["string", "null"] },
                  rating_average: { type: ["number", "null"] }, rating_count: { type: ["integer", "null"] }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "challenge", "access_gated", "rate_limited", "login_required", "not_found", "site_changed", "site_error", "canceled"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input, { signal } = {}) => {
    const CATEGORY = /^[a-z0-9-]+(\/[0-9]+)*$/;
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    // @amazon-page-fetch: keep identical in all six amazon.com tools (tests compare the copies). Uses the tool's fail and signal.
    const ORIGIN = "https://www.amazon.com";
    // Checked in order: off-host redirect, sign-in redirect, robot check, missing page (only when the caller passes a
    // not_found message), throttling, other HTTP failures, then the access notice, which counts only without the content.
    const blocked = (doc, res, content, missing) => {
      const url = res.url ? new URL(res.url) : null;
      if (url && url.origin !== ORIGIN) return fail("site_changed", "Amazon redirected outside www.amazon.com; no data is returned.");
      if (url && /^\/(?:ap|ax)\//.test(url.pathname)) return fail("login_required", "Amazon redirected to its sign-in page. Sign in to Amazon in this browser yourself, then call again.");
      if (/Robot Check|captcha/i.test(doc.title) || doc.querySelector("form[action*='validateCaptcha']")) return fail("challenge", "Amazon is showing a robot-check page for this browser. A person has to complete it on amazon.com in this browser; the tool never bypasses it or retries.");
      if (res.status === 404 && missing) return fail("not_found", missing);
      if (res.status === 429 || res.status === 503) return fail("rate_limited", "Amazon answered HTTP " + res.status + ": throttled or unavailable. Wait a few minutes; do not retry automatically.");
      if (res.status !== 200) return fail("site_error", "Amazon answered HTTP " + res.status + " instead of the requested page.");
      if (!doc.querySelector(content) && /violates Amazon.s Conditions of Use/i.test(doc.body?.textContent || "")) return fail("access_gated", "Amazon is showing a Conditions of Use notice about automated or AI-agent access instead of the page. A person has to read it and continue on amazon.com in this browser; the tool never accepts or dismisses it and returned no data.");
      return null;
    };
    const get = async (path, content, missing) => {
      const res = await fetch(path, { method: "GET", credentials: "include", headers: { accept: "text/html" }, signal, redirect: "follow" });
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      return { res, doc, error: blocked(doc, res, content, missing) };
    };
    // @amazon-page-fetch-end
    if (input === undefined || input === null) input = {};
    if (typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object. Nothing was requested.");
    const extra = Object.keys(input).find(key => !["category", "page", "limit"].includes(key));
    if (extra) return fail("invalid_input", `Unknown input '${extra}'. Nothing was requested.`);
    const category = input.category === undefined ? null : input.category;
    if (category !== null && (typeof category !== "string" || category.length > 80 || !CATEGORY.test(category))) return fail("invalid_input", "category must be a category path from categories[].category, like 'kitchen' or 'kitchen/289913'. Nothing was requested.");
    const page = input.page === undefined ? 1 : input.page, limit = input.limit === undefined ? 30 : input.limit;
    if (!Number.isInteger(page) || page < 1 || page > 2) return fail("invalid_input", "page must be 1 or 2. Nothing was requested.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail("invalid_input", "limit must be an integer from 1 to 50. Nothing was requested.");
    if (page > 1 && category === null) return fail("invalid_input", "page 2 needs a category. Nothing was requested.");
    if (location.origin !== ORIGIN) return fail("wrong_page", "Open https://www.amazon.com/ (any www.amazon.com page) in this tab, then call again. Nothing was requested.");
    if (signal?.aborted) return fail("canceled", "Canceled before any request.");

    // @amazon-text: keep identical in get_product, add_to_cart, search_products and get_best_sellers (tests compare the copies).
    const text = el => {
      if (!el) return null;
      let out = "";
      const walk = node => {
        if (node.nodeType === 3) out += node.textContent;
        else if (node.nodeType === 1 && node.localName !== "script" && node.localName !== "style") {
          for (const child of node.childNodes) walk(child);
          if (["div", "p", "li", "tr", "td", "br"].includes(node.localName)) out += " ";
        }
      };
      walk(el);
      out = out.replace(/\s+/g, " ").trim();
      return out || null;
    };
    const cents = value => {
      const m = value && /^\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)$/.exec(value);
      return m ? Math.round(parseFloat(m[1].replace(/,/g, "")) * 100) : null;
    };
    // @amazon-text-end
    let fetched;
    try {
      fetched = await get(`/gp/bestsellers${category ? `/${category}` : ""}${page > 1 ? "?pg=2" : ""}`, "#gridItemRoot, #zg-left-col a", `Amazon has no Best Sellers page for category '${category}'.`);
    } catch {
      return fail(signal?.aborted ? "canceled" : "site_error", "The request to www.amazon.com did not complete. Nothing was changed. Try again.");
    }
    if (fetched.error) return fetched.error;
    const { doc } = fetched;

    const safeImage = src => src && /^https:\/\/[a-z0-9.-]+\.(media-amazon\.com|ssl-images-amazon\.com)\//.test(src) ? src : null;
    const items = [];
    for (const node of doc.querySelectorAll("#gridItemRoot")) {
      const rank = /^#([0-9]+)$/.exec(text(node.querySelector(".zg-bdg-text")) || "");
      const holder = node.querySelector("[data-asin]");
      const asin = holder ? holder.getAttribute("data-asin") : null;
      const image = node.querySelector("img");
      const title = text(node.querySelector("[class*='line-clamp']")) || (image ? image.getAttribute("alt") : null);
      if (!rank || !/^[A-Z0-9]{10}$/.test(asin || "") || !title) continue;
      const priceText = text(node.querySelector("[class*='p13n-sc-price']"));
      const rated = node.querySelector("[aria-label*='out of 5 stars']");
      const ratedMatch = rated && /^([0-9](?:\.[0-9])?) out of 5 stars(?:, ([0-9][0-9,]*) ratings?)?$/.exec(rated.getAttribute("aria-label"));
      items.push({
        rank: Number(rank[1]), asin, title: title.slice(0, 300), url: `${ORIGIN}/dp/${asin}`, image_url: safeImage(image && image.getAttribute("src")),
        price_cents: cents(priceText), price_text: priceText,
        rating_average: ratedMatch ? parseFloat(ratedMatch[1]) : null, rating_count: ratedMatch && ratedMatch[2] ? parseInt(ratedMatch[2].replace(/,/g, ""), 10) : null
      });
    }
    const categories = [];
    for (const link of doc.querySelectorAll("#zg-left-col a")) {
      const name = text(link);
      const href = link.getAttribute("href") || "";
      const path = /\/zgbs\/([a-z0-9-]+(?:\/[0-9]+)*)(?=\/|$|\?)/.exec(href);
      const value = path ? path[1] : /\/zgbs\/(?:ref=|$|\?)/.test(href) ? null : undefined;
      if (name && value !== undefined && !categories.some(c => c.category === value) && categories.length < 60) categories.push({ name: name.slice(0, 100), category: value });
    }
    if (category && !items.length && /^Amazon Best Sellers: Best undefined/i.test(doc.title)) return fail("not_found", `Amazon has no ranking list for category '${category}'.`);
    if (!items.length && !categories.length) return fail("site_changed", "The Amazon Best Sellers page listed no products or categories; its layout may have changed. Nothing was changed.");
    if (category && !items.length) return fail("site_changed", "The Amazon Best Sellers page listed categories but no ranked products; its layout may have changed. Nothing was changed.");
    const current = text(doc.querySelector("[class*='zg-selected']"));
    const named = current ? current.replace(/\s*\(Current\)$/, "") : ((/^Amazon Best Sellers: Best (.+)$/.exec(doc.title) || [])[1] || null);
    return { status: "ok", category, category_name: category && named && named !== "undefined" ? named.slice(0, 100) : null, page, categories, items: items.slice(0, limit) };
  }
}]

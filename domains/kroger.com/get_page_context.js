[{
  kind: "page",
  match: { url_patterns: ["https://kroger.com/*", "https://*.kroger.com/*"] },
  tool: {
    name: "get_page_context",
    description: "Describe the current Kroger page so you can decide what to do next: page type (home, search results, product, cart, the got-everything upsell step, the delivery Schedule step, payment, purchase history, an in-progress order, a past receipt, sign-in), whether the browser is signed in, the shopping mode the header shows (delivery, pickup or in store) and its address or store label, the cart badge count, any order id or receipt key in the URL, which WebMCP tools the page exposes, whether it is still loading, visible alert text and suggested next tools. Read-only; never navigates or clicks.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        wait_for_settled_seconds: { type: "integer", minimum: 0, maximum: 30, default: 0, description: "Wait up to this long for the document to finish loading and stop changing before answering." }
      }
    },
    outputSchema: {
      type: "object", additionalProperties: false,
      required: ["current_url", "current_path", "page_title", "page_type", "signed_in", "fulfillment_type", "fulfillment_label", "cart_count", "order_id", "receipt_key", "available_tools", "unsettled", "page_messages", "suggested_next_steps"],
      properties: {
        current_url: { type: "string" }, current_path: { type: "string" }, page_title: { type: "string" },
        page_type: { enum: ["home", "search_results", "product", "cart", "checkout_upsell", "checkout_schedule", "checkout_payment", "purchase_history", "pending_order", "purchase_detail", "sign_in", "other"] },
        signed_in: { type: ["boolean", "null"], description: "From the site's loggedIn cookie and header; null when the page does not show it." },
        fulfillment_type: { enum: ["DELIVERY", "PICKUP", "IN_STORE", "SHIP", null], description: "Shopping mode in the site header." },
        fulfillment_label: { type: ["string", "null"], description: "Header text such as the delivery street line or pickup store name (the user's own address line, as the site shows it)." },
        cart_count: { type: ["integer", "null"], description: "Cart badge number in the header." },
        order_id: { type: ["string", "null"], description: "In-progress order id from the URL; pass to get_order." },
        receipt_key: { type: ["string", "null"], description: "Receipt key from the URL; pass to get_order." },
        available_tools: { type: ["array", "null"], items: { type: "string" }, description: "Tool names the page exposes now, or null when document.modelContext is unavailable." },
        unsettled: { type: "boolean" },
        page_messages: { type: "array", maxItems: 10, items: { type: "string", maxLength: 300 } },
        suggested_next_steps: { type: "array", items: { type: "string" } }
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  execute: async (input) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const text = el => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
    const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const waitSeconds = Math.max(0, Math.min(30, Number(input?.wait_for_settled_seconds) || 0));
    if (waitSeconds > 0) {
      const until = Date.now() + waitSeconds * 1000;
      let mutated = Date.now();
      const observer = new MutationObserver(() => { mutated = Date.now(); });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      while (Date.now() < until && (document.readyState !== "complete" || Date.now() - mutated < 1000)) await sleep(200);
      observer.disconnect();
    }
    const unsettled = document.readyState !== "complete";
    const host = location.hostname;
    const path = location.pathname.replace(/\/+$/, "") || "/";
    let pageType = "other";
    let orderId = null, receiptKey = null;
    let m;
    if (host.startsWith("login.") || /^\/signin(\/|$)/.test(path)) pageType = "sign_in";
    // Shopping, cart and order pages live on www.kroger.com; other subdomains are unrelated products.
    else if (host !== "www.kroger.com") pageType = "other";
    else if (path === "/") pageType = "home";
    else if (/^\/search(\/|$)/.test(path)) pageType = "search_results";
    else if (/^\/p\//.test(path)) pageType = "product";
    else if (path === "/cart") pageType = "cart";
    else if (path === "/got-everything") pageType = "checkout_upsell";
    else if (path === "/scheduling") pageType = "checkout_schedule";
    else if (/^\/(checkout|payment)(\/|$)/.test(path)) pageType = "checkout_payment";
    else if ((m = /^\/mypurchases\/pending\/([0-9]+)$/.exec(path))) { pageType = "pending_order"; orderId = m[1]; }
    else if ((m = /^\/mypurchases\/detail\/([^/]+)$/.exec(path))) { pageType = "purchase_detail"; receiptKey = decodeURIComponent(m[1]); }
    else if (path === "/mypurchases") pageType = "purchase_history";

    const byTestId = id => document.querySelector('[data-testid="' + id + '"]');
    const modalityText = text(byTestId("CurrentModality-textV2") || byTestId("CurrentModality-button"));
    let fulfillmentType = null;
    if (/^delivery\b/i.test(modalityText)) fulfillmentType = "DELIVERY";
    else if (/^pickup\b/i.test(modalityText)) fulfillmentType = "PICKUP";
    else if (/^in[- ]?store\b/i.test(modalityText)) fulfillmentType = "IN_STORE";
    else if (/^ship\b/i.test(modalityText)) fulfillmentType = "SHIP";
    const fulfillmentLabel = text(byTestId("CurrentModality-vanityName")) || null;
    const badge = text(byTestId("CartHeader-badge"));
    const cartCount = /^\d+$/.test(badge) ? Number(badge) : (byTestId("CartLink") ? 0 : null);
    let signedIn = null;
    if (/(^|;\s*)loggedIn=yes(;|$)/.test(document.cookie)) signedIn = true;
    else if (/(^|;\s*)loggedIn=no(;|$)/.test(document.cookie)) signedIn = false;
    else { const w = text(byTestId("WelcomeButtonDesktop")); if (w) signedIn = !/^sign in$/i.test(w); }

    let availableTools = null;
    try {
      const mc = document.modelContext || navigator.modelContext;
      if (mc && typeof mc.getTools === "function") availableTools = [...new Set(((await mc.getTools()) || []).map(t => String(t?.name ?? t).split(".").pop()).filter(Boolean))].sort();
    } catch { availableTools = null; }
    const has = name => availableTools === null || availableTools.includes(name);

    const messages = [];
    for (const el of document.querySelectorAll('[role="alert"], [aria-live="assertive"], [class*="ErrorMessage"], [class*="error-message"]')) {
      const t = text(el).slice(0, 300);
      // Kroger marks prices as live regions; they are not alerts.
      if (!t || t.length <= 3 || !visible(el) || /^(about)?\s*\$\d/.test(t) || messages.includes(t)) continue;
      messages.push(t);
      if (messages.length >= 10) break;
    }

    const steps = [];
    if (unsettled) steps.push("The page is still loading: call get_page_context with wait_for_settled_seconds before acting");
    if (signedIn === false || pageType === "sign_in") steps.push(has("login") ? "Sign in with the login tool before using cart or order tools" : "The user must sign in before cart or order tools work");
    if (pageType === "checkout_upsell") steps.push("This is the site's optional upsell step before scheduling; nothing here is required. Do not add suggested items unless the user asks");
    if (pageType === "checkout_schedule") {
      if (has("get_delivery_slots")) steps.push("Use get_delivery_slots to read delivery windows and fees; it never reserves a window");
      steps.push("Selecting a window and pressing Continue may reserve it and leads to payment; that is the user's action, no tool does it");
    }
    if (pageType === "checkout_payment") steps.push("This is the payment and Place Order step: placing, paying for or changing an order is the user's action only; never press Place Order");
    if (pageType === "pending_order" || pageType === "purchase_detail") {
      if (messages.some(t => /unable to retrieve/i.test(t))) steps.push("The site could not load this order; check the id with list_orders");
      else if (has("get_order")) steps.push("Use get_order with " + (orderId ? "order_id " + orderId : "receipt_key " + receiptKey) + " for items, fees, totals and whether the site still allows changes");
      steps.push("Modifying or canceling an order is the user's action on the site; no tool performs it");
    }
    if (pageType === "purchase_history" && has("list_orders")) steps.push("Use list_orders for in-progress orders and purchase history, then get_order for one order");
    if (pageType === "cart" || pageType === "product" || pageType === "search_results" || pageType === "home") {
      if (has("search_products")) steps.push("Use search_products to find items and get_product for one UPC");
      if (has("get_cart")) steps.push("Use get_cart for lines, quantities, substitution policy and the estimated subtotal; add_to_cart, update_cart_item and set_substitution_preference change it");
      if (fulfillmentType === "DELIVERY" && cartCount !== 0 && has("get_delivery_slots")) steps.push("Use get_delivery_slots to see delivery windows and fees for the current cart");
    }
    if (!steps.length) steps.push("Open https://www.kroger.com/cart or https://www.kroger.com/mypurchases, then call get_page_context again");
    steps.push("After any navigation, rediscover tools; tool references are bound to the document");
    return {
      current_url: location.href, current_path: path, page_title: document.title, page_type: pageType, signed_in: signedIn,
      fulfillment_type: fulfillmentType, fulfillment_label: fulfillmentLabel, cart_count: cartCount, order_id: orderId, receipt_key: receiptKey,
      available_tools: availableTools, unsettled, page_messages: messages, suggested_next_steps: steps
    };
  }
}]

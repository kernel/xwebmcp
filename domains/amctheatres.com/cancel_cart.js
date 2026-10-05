[{
  kind: "cdp",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "cancel_cart",
    title: "Release the open AMC cart",
    description: "Cancel the AMC cart open in this tab and release its seats, the way a person does: press the cart page's close button, then Yes on AMC's 'Closing this window will cancel your order' prompt. AMC then leaves the cart for its home page. Only acts on an AMC order page (/orders/...) and only before payment; it cannot cancel or refund a purchased order. Returns canceled once AMC has left the cart page; if AMC shows no prompt, or stays on the cart, it presses nothing further and reports it.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        { type: "object", additionalProperties: false, required: ["status", "observed_at"], properties: { status: { const: "canceled" }, observed_at: { type: "string" } } },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "no_cart", "wrong_page", "not_ready", "challenge", "canceled", "outcome_unknown"] },
            error_message: { type: "string" }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)) return fail("invalid_input", "This tool takes no inputs.");
    const where = () => js(() => ({ origin: location.origin, path: location.pathname, search: location.search, title: document.title, missing: [...document.querySelectorAll("h1, h2")].some(h => h.textContent.trim() === "Error 404") }));
    const start = await where();
    if (/just a moment|attention required|access denied/i.test(start.title || "")) return fail("challenge", "AMC is blocking access. This tool does not bypass the challenge.");
    if (start.origin === "https://www.amctheatres.com" && !/^\/orders\/[^/]+\/(food-and-drink|purchase)\/?$/.test(start.path) && /[?&]order-token=/.test(start.search || "")) return fail("wrong_page", "This is the Edit Tickets page of an open cart, opened from its Edit link, not the cart. cancel_cart releases a cart only on the cart page, and no tool returns to it: ask the user to finish editing or go back to the cart in this tab. AMC may already have released the order when Edit was pressed; otherwise the seats stay held until its timer runs out. Nothing was pressed.");
    if (start.origin !== "https://www.amctheatres.com" || !/^\/orders\/[^/]+\/(food-and-drink|purchase)\/?$/.test(start.path)) return fail("no_cart", "The tab is not on an AMC cart before payment; there is nothing for this tool to release.");
    if (start.missing) return fail("no_cart", "AMC no longer has this order (it shows Error 404); the cart was already released or has expired.");
    const armed = await js(() => {
      const close = [...document.querySelectorAll("a")].filter(a => (a.getAttribute("aria-label") === "Close" || a.textContent.trim() === "Close") && a.getClientRects().length);
      if (close.length !== 1) return false;
      close[0].setAttribute("data-xwebmcp-cancel", "close");
      return true;
    });
    if (!armed) return fail("not_ready", "The cart page shows no single close button; nothing was pressed.");
    if (context?.signal?.aborted) return fail("canceled", "The call was canceled; nothing was pressed and the cart is still open.");
    await click('a[data-xwebmcp-cancel="close"]');
    let prompt = false;
    for (let i = 0; i < 20 && !prompt; i++) {
      await waitMs(150);
      prompt = await js(() => {
        if (!/Closing this window will cancel your order/.test(document.body.innerText || "")) return false;
        const yes = [...document.querySelectorAll("button")].filter(b => b.textContent.trim() === "Yes" && b.getClientRects().length);
        if (yes.length !== 1) return false;
        yes[0].setAttribute("data-xwebmcp-cancel", "yes");
        return true;
      }).catch(() => false);
    }
    if (!prompt) {
      const now = await where().catch(() => null);
      if (now && !/^\/orders\//.test(now.path)) return fail("outcome_unknown", "The close button left the cart without AMC's cancel prompt. The order may still hold the seats until AMC's timer runs out.");
      return fail("not_ready", "AMC did not ask to confirm the cancellation, so Yes was not pressed and the cart is still open.");
    }
    if (context?.signal?.aborted) return fail("canceled", "The call was canceled before Yes was pressed; AMC's prompt is open and the cart is still held.");
    await click('button[data-xwebmcp-cancel="yes"]');
    for (let i = 0; i < 60; i++) {
      await waitMs(250);
      const now = await where().catch(() => null);
      if (now && !/^\/orders\//.test(now.path)) return { status: "canceled", observed_at: new Date().toISOString() };
    }
    return fail("outcome_unknown", "Yes was pressed once but AMC stayed on the cart for 15 seconds. Check with get_cart; AMC releases the seats when its timer runs out in any case.");
  }
}]

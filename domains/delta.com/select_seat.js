[{
  kind: "page",
  match: { url_patterns: ["https://www.delta.com/seats*"] },
  tool: {
    name: "select_seat",
    description: "On the open Delta seat map, choose one seat (for example \"22B\" from list_seat_map) for the passenger Delta has active on the flight shown. Free seats are taken with one click. Seats with a fee (preferred, Comfort, First) open Delta's price popover; the tool reads the fee and presses its SELECT SEAT button only when the fee is at most max_additional_fee (default 0), otherwise it closes the popover and returns fee_required with the amount so the user can decide. Nothing is saved or charged here: the choice is kept only after continue_checkout with from_step seat_map (Save & Exit), and the fee then appears in the trip total. Requires confirm:true and expected_seat_fees equal to the current subtotal before the change; stale fees return stale_state. Does not navigate.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["seat", "confirm", "expected_seat_fees"],
      properties: {
        confirm: { const: true },
        expected_seat_fees: { type: "number", minimum: 0, description: "Current extra seat subtotal before selecting; mismatch returns stale_state." },
        seat: { type: "string", pattern: "^[0-9]{1,2}[A-Ka-k]$", description: "Row and letter, e.g. 22B." },
        max_additional_fee: { type: "number", minimum: 0, maximum: 2000, default: 0, description: "Largest extra per-passenger amount (USD) the user agreed to pay for this seat. 0 means free seats only." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "seat", "additional_fee", "passenger_seats", "next_step"],
          properties: {
            status: { const: "selected" },
            seat: { type: "string" },
            additional_fee: { type: ["number", "null"], description: "Fee from Delta's popover; 0 when the seat was free; null if Delta showed no amount." },
            passenger_seats: { type: "array", items: { type: ["string", "null"] } },
            next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "seat", "additional_fee", "error_message"],
          properties: {
            status: { const: "fee_required" },
            seat: { type: "string" },
            additional_fee: { type: "number" },
            seat_description: { type: ["string", "null"] },
            error_message: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: { status: { enum: ["not_available", "not_found", "not_confirmed", "stale_state", "not_ready", "error"] }, error_message: { type: "string" }, seat: { type: "string" } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    if (input?.confirm !== true) return { status: "not_confirmed", error_message: "Explicit confirmation is required." };
    if (!Number.isFinite(input?.expected_seat_fees) || input.expected_seat_fees < 0) return { status: "error", error_message: "expected_seat_fees must be a finite nonnegative number." };
    const seat = String(input?.seat || "").toUpperCase();
    if (!/^\d{1,2}[A-K]$/.test(seat)) return { status: "error", error_message: "seat must look like 22B." };
    const maxFee = input?.max_additional_fee ?? 0;
    if (typeof maxFee !== "number" || !(maxFee >= 0) || maxFee > 2000) return { status: "error", error_message: "max_additional_fee must be a number from 0 to 2000." };
    if (!/^\/seats/.test(location.pathname)) return { status: "error", error_message: "Not on Delta's seat map; use open_seat_map from Trip Summary." };

    if (!document.querySelector("button.seat-element")) return { status: "not_ready", error_message: "Seat map is not loaded; no seat was clicked." };
    const readFees = () => [...document.querySelectorAll(".passenger-info__col--price_info")].reduce((sum, e) => { const t = text(e); const m = /\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(t); return sum + (m ? Number(m[1].replace(/,/g, "")) : t ? NaN : 0); }, 0);
    const currentFees = readFees();
    if (!Number.isFinite(currentFees)) return { status: "error", error_message: "Seat subtotal is unreadable; nothing selected." };
    if (Math.abs(currentFees - input.expected_seat_fees) > 0.005) return { status: "stale_state", error_message: "Seat fees changed; rediscover the map and confirm the current subtotal." };
    const button = document.getElementById("seat-" + seat) || document.querySelector('button.seat-element[data-test-id="' + seat + '"]');
    if (!button) return { status: "not_found", seat, error_message: "Seat " + seat + " is not on this aircraft's map." };
    const sprite = (b) => (/-(available|occupied|unavailable|selected)["')]/.exec(b.style?.backgroundImage || b.getAttribute("style") || "") || [])[1];
    const held = () => [...document.querySelectorAll(".passenger-info__seat_number")].map((e) => text(e) || null);
    if (sprite(button) === "selected" || held().includes(seat)) return { status: "selected", seat, additional_fee: null, passenger_seats: held(), next_step: "Seat " + seat + " was already held. Use continue_checkout with from_step seat_map to save, or select_seat for another seat." };
    const label = button.getAttribute("aria-label") || "";
    if (!/\bavailable\b/i.test(label) || /\b(occupied|unavailable)\b/i.test(label) || button.disabled) return { status: "not_available", seat, error_message: "Seat " + seat + " is not available (" + (label || "no label") + ")." };

    const popover = () => [...document.querySelectorAll("idp-seats-popover")].find((p) => visible(p) && new RegExp("\\b" + seat + "\\b").test(text(p.querySelector(".seat-number")) || p.className));
    button.click();
    const until = Date.now() + 5000;
    let pop = null;
    while (Date.now() < until) {
      await sleep(200);
      if (held().includes(seat)) break;
      pop = popover();
      if (pop) break;
    }
    if (held().includes(seat) && !pop) {
      await sleep(500);
      const extra = Math.max(0, readFees() - currentFees);
      if (!Number.isFinite(extra) || extra > maxFee) return { status: "error", seat, error_message: "Delta assigned an unsaved seat with an unreadable or unapproved extra fee. Use skip_seat_selection to discard it; do not save." };
      return { status: "selected", seat, additional_fee: extra, passenger_seats: held(), next_step: "Seat is held, with $" + extra.toFixed(2) + " additional fees. Recheck the seat subtotal before continue_checkout, or skip_seat_selection to discard." };
    }
    if (!pop) return { status: "error", seat, error_message: "Delta neither assigned " + seat + " nor showed its price; read list_seat_map again." };

    const amountText = text(pop.querySelector(".upsell-currency-amount"));
    const fee = /^\d+(?:,\d{3})*(?:\.\d{1,2})?$/.test(amountText) ? Number(amountText.replace(/,/g, "")) : null;
    const description = [...new Set([text(pop.querySelector(".seat-cabin-name")), text(pop.querySelector('.seat-desc-header [aria-hidden="true"]') || pop.querySelector(".seat-desc-header"))].filter(Boolean))].join(" - ") || null;
    const close = () => { const x = pop.querySelector(".seat-popover-close-icon"); if (x) x.click(); };
    if (fee === null || !(fee <= maxFee)) {
      close();
      if (fee === null) return { status: "error", seat, error_message: "Delta's popover for " + seat + " showed no readable price; nothing selected." };
      return { status: "fee_required", seat, additional_fee: fee, seat_description: description, error_message: "Seat " + seat + " costs $" + fee.toFixed(2) + " extra per passenger, above max_additional_fee " + maxFee + ". Ask the user; retry with max_additional_fee >= " + fee + " only if they agree." };
    }
    const select = [...pop.querySelectorAll("button")].find((b) => visible(b) && /^select seat$/i.test(text(b)));
    if (!select) { close(); return { status: "error", seat, error_message: "Delta's popover for " + seat + " has no SELECT SEAT button; nothing selected." }; }
    select.click();
    const until2 = Date.now() + 5000;
    while (!held().includes(seat) && Date.now() < until2) await sleep(200);
    if (!held().includes(seat)) return { status: "error", seat, error_message: "Pressed SELECT SEAT but the passenger panel does not show " + seat + "; read list_seat_map before retrying." };
    return { status: "selected", seat, additional_fee: fee, passenger_seats: held(), next_step: "Seat " + seat + " is held on the map (+$" + fee.toFixed(2) + " per passenger, charged only at purchase). Use continue_checkout with from_step seat_map and the fee as expected_seat_fees to save it." };
  }
}]

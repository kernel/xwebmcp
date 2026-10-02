[{
  kind: "cdp",
  match: { url_patterns: ["https://doordash.com/*", "https://*.doordash.com/*"] },
  tool: {
    name: "create_business_profile",
    description: "Create the signed-in DoorDash account's business profile from Account > Profile: sets the work email that receives PDF receipts and adds a new credit/debit card as the business payment method. The card fields are Very Good Security iframes, so the tool types into them with trusted key events. Selects the new card, then clicks Create profile. Add Card and Create profile are each clicked at most once and never retried (per-tab guards block repeats for ten minutes); when the business profile dialog is already open and lists the card ending in the given last four digits, the tool resumes from it without adding the card again. Refuses when signed out or when a business profile already exists. Does not place orders, change the personal profile, or accept offers. Card details are never returned; only the last four digits are. created=true means the profile page shows the business profile after Create profile. Listed on doordash.com pages; allow 120 seconds.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        work_email: { type: "string", format: "email", minLength: 6, maxLength: 254, description: "Email that receives business receipts." },
        card: {
          type: "object",
          additionalProperties: false,
          properties: {
            number: { type: "string", pattern: "^[0-9 ]{13,23}$", description: "Card number; never returned or logged." },
            expiration: { type: "string", pattern: "^(0[1-9]|1[0-2])/?([0-9]{2})$", description: "MM/YY." },
            cvc: { type: "string", pattern: "^[0-9]{3,4}$" },
            zip: { type: "string", pattern: "^[0-9]{5}$", description: "Billing ZIP code." }
          },
          required: ["number", "expiration", "cvc", "zip"]
        }
      },
      required: ["work_email", "card"]
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["created", "work_email_hint", "card_last4", "evidence"],
          properties: {
            created: { const: true },
            work_email_hint: { type: "string" },
            card_last4: { type: "string", pattern: "^[0-9]{4}$" },
            evidence: { type: "string", minLength: 1 }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["created", "error_kind", "error_message", "card_submitted", "profile_submitted", "step"],
          properties: {
            created: { const: false },
            error_kind: { enum: ["invalid_input", "not_signed_in", "profile_exists", "card_declined", "captcha_or_challenge", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            card_submitted: { type: "boolean", description: "Add Card was clicked; the card may be saved to the account even if a later step failed. Never retry automatically." },
            profile_submitted: { type: "boolean" },
            step: { enum: ["input", "session_check", "profile_page", "modal", "card_form", "card_submit", "profile_submit"] }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input, context) => {
    let cardSubmitted = false;
    let profileSubmitted = false;
    let step = "input";
    const started = Date.now();
    const BUDGET_MS = 112000;
    const signal = context && context.signal;
    const cancelled = () => (!!signal && signal.aborted) || Date.now() - started > BUDGET_MS;
    const PROFILE_URL = "https://www.doordash.com/consumer/edit_profile/";
    const GUARD_KEY = "doordash.com.create_business_profile.submitted.v1";
    const GUARD_TTL_MS = 600000;
    const mask = address => address.replace(/^(.).*?(@.*)$/, "$1***$2");
    const fail = (kind, message) => ({ created: false, error_kind: kind, error_message: message, card_submitted: cardSubmitted, profile_submitted: profileSubmitted, step });

    // @xwebmcp-inline lib/input.js
    const typeInto = async (target, text, options = {}) => {
      await click(target);
      if (options.clear !== false) {
        // Control+A is select-all on Linux/Windows but not macOS, and macOS Chrome runs no editing
        // shortcuts for synthetic key events. The explicit selectAll command works on every platform.
        const keyA = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 };
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2, location: 1 });
        try {
          await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", ...keyA, commands: ["selectAll"] });
          await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...keyA });
        } finally {
          await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 0, location: 1 });
        }
        await pressKey("Backspace");
        const leftover = () => js(() => {
          const e = document.activeElement;
          if (!e) return null;
          if (typeof e.value === "string") return e.value;
          return e.isContentEditable ? e.textContent : null;
        });
        if (await leftover()) {
          await js(() => {
            const e = document.activeElement;
            if (typeof e.select === "function") e.select();
            else window.getSelection().selectAllChildren(e);
          });
          await pressKey("Backspace");
          const rest = await leftover();
          if (rest) throw new Error("typeInto: could not clear the field, it still holds " + rest.length + " character(s)");
        }
      }
      const shifted = '~!@#$%^&*()_+{}|:"<>?';
      const unshifted = '`1234567890-=[]\\;\',./';
      const random = options.random || Math.random;
      let previous = "";
      for (const character of text) {
        if (previous && options.cadence !== "none") {
          const pause = /[.@\s]/.test(previous) ? [80, 200] : [50, 120];
          await waitMs(pause[0] + Math.floor(random() * (pause[1] - pause[0] + 1)));
        }
        const uppercase = character >= "A" && character <= "Z";
        const symbol = shifted.indexOf(character);
        if (uppercase || symbol !== -1) {
          await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8, location: 1 });
          try {
            await pressKey(uppercase ? character.toLowerCase() : unshifted[symbol], ["Shift"]);
          } finally {
            await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0, location: 1 });
          }
        } else {
          await pressKey(character);
        }
        previous = character;
      }
    };
    // @xwebmcp-end

    const card = input && typeof input === "object" && !Array.isArray(input) ? input.card : null;
    const workEmail = input && typeof input.work_email === "string" ? input.work_email.trim() : "";
    const number = card && typeof card.number === "string" ? card.number.replace(/ /g, "") : "";
    const exp = card && typeof card.expiration === "string" ? card.expiration.match(/^(0[1-9]|1[0-2])\/?([0-9]{2})$/) : null;
    const luhn = n => [...n].reverse().reduce((sum, d, i) => { let v = Number(d); if (i % 2) { v *= 2; if (v > 9) v -= 9; } return sum + v; }, 0) % 10 === 0;
    if (!card || typeof card !== "object" || Array.isArray(card)
      || Object.keys(input).some(k => !["work_email", "card"].includes(k)) || Object.keys(card).some(k => !["number", "expiration", "cvc", "zip"].includes(k))
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(workEmail) || workEmail.length > 254
      || !/^[0-9]{13,19}$/.test(number) || !luhn(number) || !exp
      || !(typeof card.cvc === "string" && /^[0-9]{3,4}$/.test(card.cvc)) || !(typeof card.zip === "string" && /^[0-9]{5}$/.test(card.zip))) {
      return fail("invalid_input", "Provide work_email and card {number (valid card number), expiration MM/YY, cvc, zip (5 digits)}. No page action was taken.");
    }
    const last4 = number.slice(-4);

    const read = async () => js(() => {
      const visible = e => !!e && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && e.getClientRects().length > 0;
      const text = e => (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim();
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
      const top = dialogs[dialogs.length - 1] || null;
      const section = [...document.querySelectorAll("h1, h2, h3, h4, span, div")].find(e => text(e) === "Business profile" && visible(e));
      let box = section;
      while (box && box.parentElement && text(box).length < 60) box = box.parentElement;
      const createButton = !top && [...document.querySelectorAll("button")].find(b => visible(b) && text(b) === "Create profile");
      const frames = top ? [...top.querySelectorAll("iframe")].filter(visible).map(f => f.title) : [];
      const marks = { number: "Secure card number input frame", cvc: "Secure card security code input frame", expiration: "Secure card expiration date input frame", zip: "Secure text input frame" };
      if (top) for (const [key, title] of Object.entries(marks)) { const f = top.querySelector('iframe[title="' + title + '"]'); if (f) f.setAttribute("data-webmcp-dd-bp", key); }
      if (createButton) createButton.setAttribute("data-webmcp-dd-bp", "open");
      if (top) {
        const pick = [...top.querySelectorAll("button")].find(b => visible(b) && /^Credit\/Debit Card$/.test(text(b)));
        if (pick) pick.setAttribute("data-webmcp-dd-bp", "pick-card");
      }
      const errors = top ? [...top.querySelectorAll("[role=alert], span, div, p")].filter(e => visible(e) && !e.querySelector("input, button, iframe") && /invalid|declined|unable|couldn't|could not|try again|not supported|incorrect|required|error/i.test(text(e)) && text(e).length < 250).map(text) : [];
      return {
        url: location.href, onProfile: /^\/consumer\/edit_profile\/?$/.test(location.pathname),
        signedIn: /(?:^|;\s*)dd_cx_logged_in=true(?:;|$)/.test(document.cookie),
        section: box ? text(box).slice(0, 400) : null, canCreate: !!createButton,
        dialog: top ? text(top).slice(0, 600) : null,
        bpModal: !!(top && top.querySelector('[data-testid="bp-modal-create-profile-button"]')),
        bpEmail: top && top.querySelector('[data-testid="bp-modal-work-email-input"]') ? top.querySelector('[data-testid="bp-modal-work-email-input"]').value : null,
        createEnabled: !!(top && (b => b && !b.disabled && b.getAttribute("aria-disabled") !== "true")(top.querySelector('[data-testid="bp-modal-create-profile-button"]'))),
        cardRadio: (() => { if (!top) return null; const r = [...top.querySelectorAll('[role="radio"]')].find(e => visible(e) && text(e).includes(window.__ddBpLast4 || "\u0000")); if (!r) return null; r.setAttribute("data-webmcp-dd-bp", "card-radio"); return r.getAttribute("aria-checked"); })(),
        created: !!box && /Delete profile|Edit profile/.test(text(box)) && text(box).includes(window.__ddBpLast4 || "\u0000"),
        cardForm: frames.length >= 3, frames, errors: [...new Set(errors)],
        challenge: [...document.querySelectorAll("iframe")].some(f => visible(f) && /captcha|challenge/i.test(f.title + " " + f.src) && f.getBoundingClientRect().width > 100) ? "Visible challenge frame" : null
      };
    });
    const settle = async (predicate, seconds) => {
      const deadline = Date.now() + seconds * 1000;
      while (Date.now() < deadline && !cancelled()) {
        try { const s = await read(); if (predicate(s)) return s; } catch { /* re-render */ }
        await waitMs(400);
      }
      return null;
    };

    try {
      step = "session_check";
      let s = await read();
      await js(last => { window.__ddBpLast4 = last; }, { arg: last4 });
      s = await read();
      const resume = s.onProfile && s.bpModal && !s.cardForm && !!s.cardRadio;
      if (!resume) {
        if (!s.onProfile) { step = "profile_page"; await gotoUrl(PROFILE_URL); await settle(x => x.onProfile, 15); await js(last => { window.__ddBpLast4 = last; }, { arg: last4 }); }
        s = await settle(x => x.onProfile && (x.canCreate || !!x.section || !!x.challenge), 20);
        if (!s) return fail("unknown", "The profile page did not load its Business profile section.");
        if (!s.signedIn) return fail("not_signed_in", "The browser is not signed in to DoorDash.");
        if (s.challenge) return fail("captcha_or_challenge", s.challenge);
        if (!s.canCreate) return fail("profile_exists", "No Create profile control: a business profile appears to exist already. Nothing was changed.");
      }
      const arm = async name => js(guard => {
        const previous = Number(sessionStorage.getItem(guard.key) || 0);
        if (previous && Date.now() - previous < guard.ttl) return false;
        sessionStorage.setItem(guard.key, String(Date.now()));
        return true;
      }, { arg: { key: GUARD_KEY + "." + name, ttl: GUARD_TTL_MS } });
      if (!resume) {
        step = "modal";
        await click('[data-webmcp-dd-bp="open"]');
        s = await settle(x => x.bpModal, 10);
        if (!s) return fail("unknown", "The Create your business profile dialog did not open.");
        await typeInto('[data-testid="bp-modal-work-email-input"]', workEmail);
        s = await read();
        if ((s.bpEmail || "").trim().toLowerCase() !== workEmail.toLowerCase()) return fail("unknown", "The work email field did not hold the address; nothing was submitted.");

        step = "card_form";
        await click('[data-webmcp-dd-bp="pick-card"]');
        s = await settle(x => x.cardForm, 10);
        if (!s) return fail("unknown", "The Add New Card form did not open; nothing was submitted.");
        await waitMs(1500);
        const values = { number, expiration: exp[1] + exp[2], cvc: card.cvc, zip: card.zip };
        for (const key of ["number", "expiration", "cvc", "zip"]) {
          if (cancelled()) return fail("unknown", "Cancelled while filling the card form; nothing was submitted.");
          await typeInto('[data-webmcp-dd-bp="' + key + '"]', values[key], { clear: false });
        }
        await waitMs(500);
        s = await read();
        if (s.errors.length) return fail("invalid_input", s.errors.join("\n"));

        step = "card_submit";
        if (!await arm("card")) return fail("unknown", "This tab already clicked Add Card within ten minutes; not repeating. Invoke again from the open dialog to resume.");
        cardSubmitted = true;
        await click('[data-testid="AddCardButton"]');
        s = await settle(x => (x.bpModal && !x.cardForm) || x.errors.length > 0 || !!x.challenge, 30);
        if (!s) return fail("unknown", "No result from Add Card within 30 seconds; the card may or may not be saved. Inspect the page.");
        if (s.challenge) return fail("captcha_or_challenge", s.challenge);
        if (!s.bpModal) return fail(/declin/i.test(s.errors.join(" ")) ? "card_declined" : "unknown", s.errors.join("\n") || "Add Card did not return to the business profile dialog.");
      }
      if (!s.dialog.includes(last4)) return fail("unknown", "The business profile dialog does not show the new card ending " + last4 + "; Create profile was not clicked.");
      if ((s.bpEmail || "").trim().toLowerCase() !== workEmail.toLowerCase()) {
        await typeInto('[data-testid="bp-modal-work-email-input"]', workEmail);
        s = await read();
        if ((s.bpEmail || "").trim().toLowerCase() !== workEmail.toLowerCase()) return fail("unknown", "The work email was lost after adding the card; Create profile was not clicked.");
      }
      if (s.cardRadio !== "true") {
        await click('[data-webmcp-dd-bp="card-radio"]');
        s = await settle(x => x.cardRadio === "true" && x.createEnabled, 10);
        if (!s) return fail("unknown", "Selecting the card ending " + last4 + " did not enable Create profile; nothing more was submitted.");
      }
      if (!s.createEnabled) return fail("unknown", "Create profile is disabled; nothing more was submitted.");
      if (!await arm("profile")) return fail("unknown", "This tab already clicked Create profile within ten minutes; not repeating. Inspect the page.");

      step = "profile_submit";
      profileSubmitted = true;
      await click('[data-testid="bp-modal-create-profile-button"]');
      // After creation DoorDash replaces the dialog with "Edit your business profile"; the page section is the evidence.
      s = await settle(x => x.created || (x.bpModal && x.errors.length > 0), 30);
      if (!s) return fail("unknown", "No result from Create profile within 30 seconds; inspect the page before any retry.");
      if (!s.created) return fail("unknown", s.errors.join("\n"));
      return { created: true, work_email_hint: mask(workEmail), card_last4: last4, evidence: "The Business profile section no longer offers Create profile: " + (s.section || "").replace(/[^\s]+@[^\s]+/g, m => mask(m)).slice(0, 200) };
    } catch {
      return fail("unknown", "Browser interaction failed" + (cardSubmitted ? " after Add Card was clicked; the card may be saved." : " before anything was submitted."));
    }
  }
}]

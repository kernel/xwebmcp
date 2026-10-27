[{
  kind: "cdp",
  match: { url_patterns: ["https://doordash.com/*", "https://*.doordash.com/*"] },
  tool: {
    name: "save_address",
    description: "Only call this for an address the user gave or confirmed; it changes the account's current delivery address. Make a delivery address the signed-in DoorDash account's current (default) address. Opens the header's address dialog; if the address is already saved it selects it, otherwise it searches DoorDash's address autocomplete, picks the suggestion whose street and ZIP match, fills the optional details (address type, suite/floor, business name, delivery instructions, personal label) and clicks Save once (a per-tab guard blocks a repeat for ten minutes; nothing is retried). Success is confirmed only when the header's address button shows the street. Returns the suggestions when none matches, and never picks a near match. Never edits or deletes other saved addresses. Must run on www.doordash.com while signed in; allow 90 seconds.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        street: { type: "string", minLength: 3, maxLength: 120, description: "House number and street, e.g. '1 Main St'." },
        city: { type: "string", minLength: 2, maxLength: 80 },
        state: { type: "string", pattern: "^[A-Za-z]{2}$" },
        zip: { type: "string", pattern: "^[0-9]{5}$" },
        address_type: { enum: ["house", "apartment", "hotel", "office", "other"], description: "Defaults to DoorDash's own choice when omitted." },
        suite: { type: "string", maxLength: 60 },
        business_name: { type: "string", maxLength: 80 },
        instructions: { type: "string", maxLength: 500 },
        label: { enum: ["none", "home", "work"], default: "none" }
      },
      required: ["street", "city", "state", "zip"]
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["saved", "action", "current_address", "evidence"],
          properties: {
            saved: { const: true },
            action: { enum: ["added", "selected_existing"] },
            current_address: { type: "string", description: "Address text shown in the header." },
            evidence: { type: "string", minLength: 1 }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["saved", "error_kind", "error_message", "suggestions", "save_clicked", "step"],
          properties: {
            saved: { const: false },
            error_kind: { enum: ["invalid_input", "not_signed_in", "address_not_found", "captcha_or_challenge", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            suggestions: { type: "array", items: { type: "string" }, description: "Autocomplete suggestions seen when no exact match was found." },
            save_clicked: { type: "boolean", description: "Save was clicked; the address may be stored even if confirmation failed. Never retry automatically." },
            step: { enum: ["input", "session_check", "dialog", "existing", "search", "details", "save"] }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input, context) => {
    let saveClicked = false;
    let step = "input";
    let suggestions = [];
    const started = Date.now();
    const signal = context && context.signal;
    const cancelled = () => (!!signal && signal.aborted) || Date.now() - started > 85000;
    const GUARD_KEY = "doordash.com.save_address.submitted.v1";
    const fail = (kind, message) => ({ saved: false, error_kind: kind, error_message: message, suggestions, save_clicked: saveClicked, step });

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

    const allowed = ["street", "city", "state", "zip", "address_type", "suite", "business_name", "instructions", "label"];
    const ok = (v, min, max) => typeof v === "string" && v.trim().length >= min && v.trim().length <= max;
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))
      || !ok(input.street, 3, 120) || !/^\d+\S*\s+\S/.test(input.street.trim()) || !ok(input.city, 2, 80)
      || !(typeof input.state === "string" && /^[A-Za-z]{2}$/.test(input.state)) || !(typeof input.zip === "string" && /^[0-9]{5}$/.test(input.zip))
      || ("address_type" in input && !["house", "apartment", "hotel", "office", "other"].includes(input.address_type))
      || ("label" in input && !["none", "home", "work"].includes(input.label))
      || ["suite", "business_name", "instructions"].some(k => k in input && !ok(input[k], 0, k === "instructions" ? 500 : 80))) {
      return fail("invalid_input", "Provide street (with house number), city, two-letter state and five-digit zip, plus only the documented optional fields. No page action was taken.");
    }
    const street = input.street.trim().replace(/\s+/g, " ");
    const want = { street: street.toLowerCase(), zip: input.zip, city: input.city.trim().toLowerCase() };

    // Marks dialog controls for trusted clicks and reports the dialog's step.
    const read = async () => js(want => {
      const visible = e => !!e && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && e.getClientRects().length > 0;
      const text = e => (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim();
      const norm = t => t.toLowerCase().replace(/\bstreet\b/g, "st").replace(/[.,]/g, "").replace(/\s+/g, " ");
      document.querySelectorAll("[data-webmcp-dd-addr]").forEach(e => e.removeAttribute("data-webmcp-dd-addr"));
      const header = document.querySelector('[data-testid="addressTextButton"]');
      if (header) header.setAttribute("data-webmcp-dd-addr", "header");
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
      const top = dialogs.find(d => /^Addresses/.test(text(d))) || null;
      const search = top ? top.querySelector('input[aria-label="Search for an address"]') : null;
      if (search && visible(search)) search.setAttribute("data-webmcp-dd-addr", "search");
      const close = top ? top.querySelector('[aria-label="Close"]') : null;
      if (close) close.setAttribute("data-webmcp-dd-addr", "close");
      const matches = t => norm(t).startsWith(norm(want.street)) && t.includes(want.zip);
      const options = [...document.querySelectorAll('[role="option"]')].filter(visible);
      const option = options.find(o => matches(text(o)));
      if (option) option.setAttribute("data-webmcp-dd-addr", "option");
      const select = top ? top.querySelector("select") : null;
      const saveButton = top ? [...top.querySelectorAll("button")].find(b => visible(b) && text(b) === "Save") : null;
      if (saveButton) saveButton.setAttribute("data-webmcp-dd-addr", "save");
      for (const [key, id] of [["suite", "subpremise"], ["business_name", "business_name"]]) { const f = top && top.querySelector("#" + id); if (f && visible(f)) f.setAttribute("data-webmcp-dd-addr", key); }
      const instructions = top ? [...top.querySelectorAll("textarea")].find(visible) : null;
      if (instructions) instructions.setAttribute("data-webmcp-dd-addr", "instructions");
      const labels = top ? [...top.querySelectorAll("button")].filter(b => visible(b) && /^(None|Home|Work)$/.test(text(b))) : [];
      labels.forEach(b => b.setAttribute("data-webmcp-dd-addr", "label-" + text(b).toLowerCase()));
      // Saved addresses render as list rows in the search step; only an exact street+zip row counts.
      const saved = search && !option ? [...top.querySelectorAll("button, [role=button], [role=radio], li")].filter(e => visible(e) && !e.querySelector("input") && matches(text(e).replace(/^(?:Home|Work)\s+/i, "")))[0] : null;
      if (saved) saved.setAttribute("data-webmcp-dd-addr", "saved-row");
      const heading = top ? [...top.querySelectorAll("div, span, h2, h3")].map(text).find(t => matches(t) && t.length < 120) : null;
      return {
        signedIn: /(?:^|;\s*)dd_cx_logged_in=true(?:;|$)/.test(document.cookie),
        host: location.hostname, header: header ? text(header) : null,
        dialog: !!top, searchStep: !!(search && visible(search)), searchValue: search ? search.value : "",
        suggestions: options.map(text).slice(0, 8), option: !!option, savedRow: !!saved,
        details: !!saveButton && !!select, detailsFor: heading || null,
        typeValue: select ? select.value : null, typeOptions: select ? [...select.options].map(o => [o.value, o.text]) : [],
        suite: top && top.querySelector("#subpremise") ? top.querySelector("#subpremise").value : null,
        businessName: top && top.querySelector("#business_name") ? top.querySelector("#business_name").value : null,
        instructions: instructions ? instructions.value : null,
        label: (labels.find(b => b.getAttribute("aria-pressed") === "true") || { innerText: "" }).innerText.trim().toLowerCase() || null,
        saveEnabled: !!saveButton && !saveButton.disabled && saveButton.getAttribute("aria-disabled") !== "true",
        errors: top ? [...top.querySelectorAll("[role=alert]")].filter(visible).map(text).filter(Boolean) : [],
        challenge: [...document.querySelectorAll("iframe")].some(f => visible(f) && /captcha|challenge/i.test(f.title + " " + f.src) && f.getBoundingClientRect().width > 100) ? "Visible challenge frame" : null
      };
    }, { arg: want });
    const settle = async (predicate, seconds) => {
      const deadline = Date.now() + seconds * 1000;
      while (Date.now() < deadline && !cancelled()) {
        try { const s = await read(); if (predicate(s)) return s; } catch { /* re-render */ }
        await waitMs(400);
      }
      return null;
    };
    const headerShows = s => !!s.header && s.header.toLowerCase().replace(/\bstreet\b/g, "st").replace(/[.,]/g, "").startsWith(want.street.replace(/\bstreet\b/g, "st").replace(/[.,]/g, ""));

    try {
      step = "session_check";
      let s = await read();
      // The sign-in cookie is only visible on www.doordash.com, so the host is checked first.
      if (s.host !== "www.doordash.com") return fail("unknown", "Run this on a www.doordash.com page that shows the header address button. Nothing was changed.");
      if (!s.signedIn) return fail("not_signed_in", "The browser is not signed in to DoorDash.");
      if (!s.header) return fail("unknown", "Run this on a www.doordash.com page that shows the header address button. Nothing was changed.");
      if (s.challenge) return fail("captcha_or_challenge", s.challenge);

      step = "dialog";
      if (s.dialog) {
        await click('[data-webmcp-dd-addr="close"]');
        await settle(x => !x.dialog, 5);
      }
      await click('[data-webmcp-dd-addr="header"]');
      s = await settle(x => x.searchStep, 10);
      if (!s) return fail("unknown", "The Addresses dialog did not open with a search field. Nothing was changed.");

      if (s.savedRow) {
        step = "existing";
        await click('[data-webmcp-dd-addr="saved-row"]');
        s = await settle(x => !x.dialog && headerShows(x), 15) || await settle(x => headerShows(x), 5);
        if (!s) return fail("unknown", "Selecting the saved address did not update the header. Inspect the page.");
        return { saved: true, action: "selected_existing", current_address: s.header, evidence: "The address was already saved; selecting it put it in the header address button." };
      }

      step = "search";
      // The dialog animates in; a click during the animation can land on the backdrop and close it.
      await waitMs(1200);
      s = await read();
      if (!s.searchStep) return fail("unknown", "The Addresses dialog closed before the search could be typed. Nothing was changed.");
      const query = street + ", " + input.city.trim();
      await typeInto('[data-webmcp-dd-addr="search"]', query);
      s = await read();
      if (!s.searchStep || s.searchValue !== query) return fail("unknown", "The address search field did not hold the typed query. Nothing was changed.");
      s = await settle(x => x.option || (x.suggestions.length > 1 && !x.suggestions.every(t => /manually/i.test(t))), 10);
      if (!s || !s.option) {
        suggestions = s ? s.suggestions.filter(t => !/manually/i.test(t)) : [];
        return fail("address_not_found", "No suggestion matches the street and ZIP exactly; nothing was saved. Check the address or choose one of the suggestions.");
      }
      await click('[data-webmcp-dd-addr="option"]');
      s = await settle(x => x.details, 10);
      if (!s) return fail("unknown", "Choosing the suggestion did not open the address details form; nothing was saved.");

      step = "details";
      if (input.address_type) {
        const wanted = s.typeOptions.find(([, t]) => t.toLowerCase() === input.address_type);
        if (!wanted) return fail("unknown", "The address type list does not offer " + input.address_type + "; nothing was saved.");
        if (s.typeValue !== wanted[0]) {
          await js(value => {
            const select = [...document.querySelectorAll('[role="dialog"] select')].pop();
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, value);
            select.dispatchEvent(new Event("change", { bubbles: true }));
          }, { arg: wanted[0] });
          s = await settle(x => x.typeValue === wanted[0], 5);
          if (!s) return fail("unknown", "The address type did not change; nothing was saved.");
        }
      }
      for (const key of ["suite", "business_name", "instructions"]) {
        if (!input[key]) continue;
        s = await read();
        const present = key === "suite" ? s.suite !== null : key === "business_name" ? s.businessName !== null : s.instructions !== null;
        if (!present) return fail("unknown", "The details form has no " + key.replace("_", " ") + " field for this address type; nothing was saved.");
        await typeInto('[data-webmcp-dd-addr="' + key + '"]', input[key].trim());
      }
      const label = input.label || "none";
      s = await read();
      if (s.label !== label) {
        await click('[data-webmcp-dd-addr="label-' + label + '"]');
        s = await settle(x => x.label === label, 5);
        if (!s) return fail("unknown", "The personal label did not change to " + label + "; nothing was saved.");
      }
      // The form re-renders after the label changes, so the field values are checked over a short window.
      const holds = x => !(input.suite && x.suite !== input.suite.trim()) && !(input.business_name && x.businessName !== input.business_name.trim()) && !(input.instructions && x.instructions !== input.instructions.trim()) && x.label === label;
      s = await settle(holds, 5);
      if (!s) return fail("unknown", "A details field did not hold its value; nothing was saved.");
      if (!s.saveEnabled) return fail("unknown", "Save is disabled" + (s.errors.length ? ": " + s.errors.join("; ") : "") + "; nothing was saved.");

      step = "save";
      const armed = await js(key => {
        const previous = Number(sessionStorage.getItem(key) || 0);
        if (previous && Date.now() - previous < 600000) return false;
        sessionStorage.setItem(key, String(Date.now()));
        return true;
      }, { arg: GUARD_KEY });
      if (!armed) return fail("unknown", "This tab already clicked Save within ten minutes; not repeating. Inspect the page.");
      saveClicked = true;
      await click('[data-webmcp-dd-addr="save"]');
      s = await settle(x => headerShows(x) && !x.details, 20);
      if (!s) {
        const last = await read().catch(() => null);
        return fail("unknown", "After Save the header does not show the new street" + (last && last.errors.length ? ": " + last.errors.join("; ") : "") + ". The address may be stored; inspect the page before any retry.");
      }
      if (s.dialog) { try { await click('[data-webmcp-dd-addr="close"]'); } catch { /* the dialog may close by itself */ } }
      return { saved: true, action: "added", current_address: s.header, evidence: "Save was clicked once and the header address button now shows the new street." };
    } catch {
      return fail("unknown", "Browser interaction failed" + (saveClicked ? " after Save was clicked; the address may be stored." : " before Save was clicked; nothing was saved."));
    }
  }
}]

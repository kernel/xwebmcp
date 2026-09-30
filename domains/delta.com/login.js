[{
  kind: "page",
  match: {
    url_patterns: [
      "https://www.delta.com/",
      "https://www.delta.com/?*",
      "https://www.delta.com/us/en",
      "https://www.delta.com/us/en?*",
      "https://www.delta.com/us/en/",
      "https://www.delta.com/us/en/?*"
    ]
  },
  tool: {
    name: "login",
    description: "Sign in to Delta from the homepage: opens the top-nav \"Log in\" flyout, fills the SkyMiles number or username and the password, and schedules exactly one click on the flyout's \"Log In\" button. Only registered on the Delta homepage (https://www.delta.com/ or /us/en); use navigate_to_page({ url: \"/\" }) first from any other page. The tool returns as soon as the submission is scheduled and does NOT observe the result: it cannot tell you whether the sign-in succeeded, failed, or asked for a verification code. Afterwards call get_page_context (signed_in, login_flyout_open, page_messages) or inspect the page before doing anything else, and never call login again without checking, because real accounts lock out after repeated failures. Only use credentials the user supplied for this purpose. Never retries; never navigates.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["skymiles_number_or_username", "password"],
      properties: {
        skymiles_number_or_username: { type: "string", minLength: 1, maxLength: 100, description: "SkyMiles number or Delta username. Not an email address unless it is also the username." },
        password: { type: "string", minLength: 1, maxLength: 200, description: "Password; typed into the form and never returned." }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const identifier = typeof input?.skymiles_number_or_username === "string" ? input.skymiles_number_or_username.trim() : "";
    const password = typeof input?.password === "string" ? input.password : "";
    if (!identifier || !password) throw new Error("invalid_input: skymiles_number_or_username and password are both required; nothing was typed or submitted.");

    const path = location.pathname.replace(/\/+$/, "") || "/";
    if (location.hostname !== "www.delta.com" || !["/", "/us/en"].includes(path)) {
      throw new Error("wrong_page: login only runs on the Delta homepage (https://www.delta.com/). Call navigate_to_page with url \"/\" and retry; nothing was typed or submitted.");
    }

    const dialog = () => document.querySelector("#login-modal-popup");
    const userField = () => dialog()?.querySelector("#userId-input");
    const passField = () => dialog()?.querySelector("#password-input");
    const formReady = () => dialog()?.open && visible(userField()) && visible(passField());

    if (!formReady()) {
      const trigger = document.querySelector("#login-trigger");
      if (!visible(trigger)) {
        throw new Error("login_button_missing: the top-nav \"Log in\" button is not visible, so the user may already be signed in (check get_page_context.signed_in). Nothing was typed or submitted.");
      }
      trigger.click();
      const deadline = Date.now() + 15000;
      while (!formReady() && Date.now() < deadline) await sleep(250);
      if (!formReady()) throw new Error("login_form_not_ready: clicked \"Log in\" but the flyout's username and password fields did not appear within 15 s. Nothing was typed or submitted.");
    }

    const setValue = (el, value) => {
      el.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    };
    const user = userField();
    const pass = passField();
    setValue(user, identifier);
    setValue(pass, password);
    await sleep(300);
    if (user.value !== identifier || pass.value.length !== password.length) {
      throw new Error("fill_failed: the flyout did not keep the typed values. Nothing was submitted.");
    }

    const submit = [...dialog().querySelectorAll("button")].find((b) =>
      visible(b) && (b.classList.contains("login-screen__submit-button") || /^log\s*in$/i.test((b.innerText || "").trim())));
    if (!submit) throw new Error("submit_button_missing: filled the form but found no visible \"Log In\" button. Nothing was submitted.");
    if (submit.disabled) throw new Error("submit_disabled: the \"Log In\" button is disabled after filling. Nothing was submitted.");

    // Settle before submitting: a successful sign-in may reload this document.
    setTimeout(() => submit.click(), 100);
    return "Filled the Delta log-in flyout and scheduled one click on \"Log In\". The outcome is NOT confirmed. Next: call get_page_context (signed_in, login_flyout_open, page_messages) to see whether Delta signed you in, asked for a verification code, or showed an error. Do not call login again without checking.";
  }
}]

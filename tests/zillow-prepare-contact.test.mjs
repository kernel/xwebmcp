import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/zillow.com/prepare_contact.js", import.meta.url), "utf8");
const listing = "https://www.zillow.com/homedetails/1-Example-St-Example-City-WA-99999/12345678_zpid/";
const input = { listing_url: listing, name: "Example Person", email: "example@example.test", phone: "+1 555 010 1234", message: "Please provide the public listing details." };
const disclosure = "By pressing Contact Agent, you agree to the Terms of Use and the displayed contact consent.";
const plain = value => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  let touched = 0;
  const element = attributes => Object.defineProperty({
    disabled: false, readOnly: false, getClientRects: () => options.hidden ? [] : [{}],
    getAttribute: name => attributes[name] ?? null,
    click() { throw new Error("must not click"); }, dispatchEvent() { throw new Error("must not dispatch events"); }
  }, "value", {
    get() { throw new Error("must not read prefilled account values"); },
    set(_) { throw new Error("must not fill fields"); }
  });
  const form = {
    querySelectorAll: selector => {
      if (selector === "button") return [{ ...element({}), textContent: "Contact Agent" }];
      if (options.missingField) return [];
      const labels = { 'input[name="name"][type="text"]': "Name", 'input[name="phone"][type="tel"]': "Phone", 'input[name="email"][type="email"]': "Email", 'textarea[name="message"]': "Message" };
      return labels[selector] ? [element({ "aria-label": labels[selector], "aria-required": options.optionalField ? "false" : "true" })] : [];
    },
    submit() { throw new Error("must not submit"); }, requestSubmit() { throw new Error("must not submit"); }
  };
  const dialog = {
    ...element({}),
    querySelectorAll: selector => {
      if (selector === "h4") return [{ textContent: options.otherDialog ? "Request a tour" : "Contact Listing Agent" }];
      if (selector === '[data-testid="contact-form"] form') return options.ambiguous ? [form, form] : [form];
      if (selector === "p") {
        const current = { ...element({}), textContent: options.disclosure ?? disclosure };
        const hidden = { ...element({}), getClientRects: () => [], textContent: "By pressing Contact Agent, hidden outdated Terms of Use." };
        return options.onlyHiddenDisclosure ? [hidden] : options.hiddenDisclosure ? [hidden, current] : [current];
      }
      return [];
    }
  };
  const context = {
    location: new URL(options.url || listing),
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    fetch: () => { throw new Error("must not fetch"); },
    document: {
      get title() { touched++; return options.challenge ? "Access to this page has been denied" : "Zillow"; },
      getElementById: () => null,
      querySelectorAll: selector => { touched++; assert.equal(selector, '[role="dialog"]'); return options.noDialog ? [] : [dialog]; }
    }
  };
  const [definition] = runInNewContext(`(${source})`, context);
  return { definition, touched: () => touched, run: async (value = input, invocation = {}) => plain(await definition.execute(value, invocation)) };
}

test("zillow prepare_contact: typed read-only local preview with no form interaction", async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(h.definition.kind, "page");
  assert.equal(h.definition.tool.annotations.readOnlyHint, true);
  assert.equal(result.status, "prepared");
  assert.deepEqual(result.preview, { name: input.name, email: input.email, phone: input.phone, message: input.message });
  assert.equal(result.zpid, "12345678");
  assert.equal(result.fields_filled, false);
  assert.equal(result.submitted, false);
  assert.equal(result.consent_disclosure, disclosure);
  assert.deepEqual(Object.keys(result).sort(), plain(h.definition.tool.outputSchema.oneOf[0].required).sort());
});
for (const value of [undefined, null, [], {}, { ...input, confirmed: true }, { ...input, message: "" }, { ...input, message: "x".repeat(2001) }, { ...input, email: "invalid" }, { ...input, phone: "abc" }, { ...input, name: "x\u0000y" }, { ...input, listing_url: listing + "?view=owner" }, { ...input, listing_url: listing.replace("www.zillow.com", "user:pass@www.zillow.com") }]) {
  test(`zillow prepare_contact: invalid input is rejected before page access ${JSON.stringify(value)}`, async () => {
    const h = harness();
    // A missing argument must be passed explicitly because run's default is valid.
    const result = plain(await h.definition.execute(value));
    assert.equal(result.error_kind, "invalid_input");
    assert.equal(h.touched(), 0);
  });
}
for (const [options, kind] of [
  [{ url: "https://example.test/" }, "wrong_page"], [{ url: listing.replace("12345678", "99999999") }, "wrong_property"], [{ challenge: true }, "challenge"],
  [{ noDialog: true }, "form_not_open"], [{ hidden: true }, "form_not_open"], [{ otherDialog: true }, "form_not_open"], [{ missingField: true }, "site_changed"],
  [{ optionalField: true }, "site_changed"], [{ ambiguous: true }, "site_changed"], [{ onlyHiddenDisclosure: true }, "site_changed"], [{ disclosure: "changed consent" }, "site_changed"], [{ disclosure: "By pressing Contact Agent, " + "x".repeat(3100) }, "site_changed"]
]) {
  test(`zillow prepare_contact: prerequisite failure ${JSON.stringify(options)} is ${kind}`, async () => {
    const result = await harness(options).run();
    assert.equal(result.status, "error");
    assert.equal(result.error_kind, kind);
  });
}
test("zillow prepare_contact: ignores hidden consent text before the visible disclosure", async () => {
  const result = await harness({ hiddenDisclosure: true }).run();
  assert.equal(result.status, "prepared");
  assert.equal(result.consent_disclosure, disclosure);
});

test("zillow prepare_contact: cancellation is checked before page access", async () => {
  const h = harness();
  assert.equal((await h.run(input, { signal: { aborted: true } })).error_kind, "canceled");
  assert.equal(h.touched(), 0);
});

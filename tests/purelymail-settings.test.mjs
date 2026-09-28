import assert from "node:assert/strict";
import test from "node:test";
import { pageTool, plain, server } from "./fixtures/purelymail/server.mjs";

// Filters are stored in the fixture the way the managesieve plugin models them.
const rule = (header, op, targets, extra = {}) => ({ header, op, targets, custom: [], mod: "", comp: "", trans: "text", ...extra });
const siteFilter = (name, extra = {}) => ({ name, enabled: true, join: "allof", rules: [rule("subject", "contains", ["newsletter"])], actions: [{ type: "fileinto", mailbox: "Junk" }], ...extra });
const vacationFilter = (name, extra = {}) => ({ name, enabled: false, join: "any", rules: [], actions: [{ type: "vacation", reason: "Away until Monday.", subject: "Out of office", from: "", addresses: [], interval: "3", intervalType: "days" }], ...extra });
const withInvoices = () => ({ folders: [{ id: "INBOX", name: "Inbox", class: "inbox" }, { id: "Sent", name: "Sent", class: "sent" }, { id: "Junk", name: "Junk", class: "junk" }, { id: "Invoices", name: "Invoices", class: "mailbox" }] });
const invoiceFilter = { name: "Invoices", conditions: [{ field: "subject", operator: "contains", values: ["invoice"] }], actions: [{ type: "add_flags", flags: ["flagged"] }, { type: "move_to_folder", folder: "Invoices" }], confirm: true };

test("settings tools refuse to run off the webmail origin or without a session, and change nothing", async () => {
  const inputs = { list_filters: {}, get_filter: { name: "x" }, create_filter: invoiceFilter, update_filter: { name: "x", changes: { enabled: false }, confirm: true }, delete_filter: { name: "x", confirm: true }, get_vacation_responder: {}, set_vacation_responder: { enabled: false, confirm: true }, create_folder: { name: "Invoices", confirm: true } };
  for (const [name, input] of Object.entries(inputs)) {
    assert.equal((await pageTool(name, server(), { origin: "https://purelymail.com" }).run(input)).error_kind, "wrong_page", name);
    const backend = server({ loggedIn: false });
    const result = await pageTool(name, backend, { header: false }).run(input);
    assert.equal(result.error_kind, "not_authenticated", name);
    assert.equal(backend.state.posts.length, 0, name);
    if ("changed" in result) assert.equal(result.changed, false, name);
  }
});

test("create_filter builds the subject filter that flags and files invoices, idempotently", async () => {
  const backend = server({ ...withInvoices(), filters: [siteFilter("Newsletters")] });
  const result = await pageTool("create_filter", backend).run(invoiceFilter);
  assert.equal(result.status, "ok");
  assert.equal(result.created, true);
  assert.deepEqual(result.filter, {
    position: 1, name: "Invoices", enabled: true, match: "all",
    conditions: [{ field: "subject", header_name: null, operator: "contains", values: ["invoice"] }],
    actions: [{ type: "add_flags", flags: ["flagged"] }, { type: "move_to_folder", folder: "Invoices" }], editable: true
  });
  assert.deepEqual(plain(backend.state.filters[1]), {
    name: "Invoices", enabled: true, join: "allof", rules: [rule("subject", "contains", ["invoice"])],
    actions: [
      { type: "addflag", mailbox: "INBOX", flags: ["\\Flagged"], reason: "", subject: "", from: "", addresses: [], interval: "", intervalType: "days" },
      { type: "fileinto", mailbox: "Invoices", flags: [], reason: "", subject: "", from: "", addresses: [], interval: "", intervalType: "days" }
    ]
  });
  assert.equal(backend.state.filters[0].name, "Newsletters", "existing filters are untouched");
  const posts = backend.state.posts.length;
  const again = await pageTool("create_filter", backend).run(invoiceFilter);
  assert.equal(again.created, false);
  assert.equal(backend.state.posts.length, posts, "an identical repeat submits nothing");
  const clash = await pageTool("create_filter", backend).run({ ...invoiceFilter, actions: [{ type: "move_to_folder", folder: "Junk" }] });
  assert.equal(clash.error_kind, "already_exists");
  assert.equal(clash.changed, false);
});

test("create_filter validates the definition before submitting anything", async () => {
  const cases = [
    { ...invoiceFilter, confirm: false },
    { ...invoiceFilter, actions: [{ type: "move_to_folder", folder: "Missing" }] },
    { ...invoiceFilter, actions: [{ type: "move_to_folder", folder: "Invoices" }, { type: "add_flags", flags: ["flagged"] }] },
    { ...invoiceFilter, actions: [{ type: "stop" }, { type: "keep" }] },
    { ...invoiceFilter, actions: [{ type: "redirect", target: "someone@example.net" }] },
    { ...invoiceFilter, actions: [{ type: "add_flags", flags: ["deleted"] }] },
    { ...invoiceFilter, conditions: [] },
    { ...invoiceFilter, match: "every_message" },
    { ...invoiceFilter, conditions: [{ field: "subject", operator: "contains", values: [] }] },
    { ...invoiceFilter, conditions: [{ field: "header", operator: "exists" }] },
    { ...invoiceFilter, name: "a\nb" }
  ];
  for (const input of cases) {
    const backend = server(withInvoices());
    const result = await pageTool("create_filter", backend).run(input);
    assert.equal(result.error_kind, "invalid_input", JSON.stringify(input));
    assert.equal(result.changed, false);
    assert.equal(backend.state.posts.length, 0);
  }
});

test("filter saves report rejections and unknown outcomes without retrying", async () => {
  const rejected = server({ ...withInvoices(), saveResponse: "error" });
  const refused = await pageTool("create_filter", rejected).run(invoiceFilter);
  assert.equal(refused.error_kind, "site_rejected");
  assert.equal(refused.changed, false);
  for (const mode of ["network", "silent"]) {
    const backend = server({ ...withInvoices(), saveResponse: mode });
    const result = await pageTool("create_filter", backend).run(invoiceFilter);
    assert.equal(result.error_kind, "outcome_unknown", mode);
    assert.equal(result.changed, "unknown");
    assert.equal(backend.state.posts.length, 1, "exactly one submission");
  }
  const ignored = server({ ...withInvoices(), ignoreSaves: true });
  const mismatch = await pageTool("create_filter", ignored).run(invoiceFilter);
  assert.equal(mismatch.error_kind, "outcome_unknown", "a confirmation that the readback contradicts is not reported as success");
});

test("list_filters and get_filter read every filter, flagging ones the tools cannot rewrite", async () => {
  const backend = server({ filters: [siteFilter("Newsletters", { enabled: false }), siteFilter("Forward boss", { actions: [{ type: "redirect", mailbox: "INBOX" }] }), siteFilter("Big", { rules: [rule("size", "over", [])] }), vacationFilter("Vacation responder")], setActive: false });
  const list = await pageTool("list_filters", backend).run({});
  assert.equal(list.status, "ok");
  assert.equal(list.filter_set, "roundcube");
  assert.equal(list.filter_set_active, false);
  assert.deepEqual(list.filters.map(f => [f.position, f.name, f.enabled, f.editable]), [[0, "Newsletters", false, true], [1, "Forward boss", true, false], [2, "Big", true, false], [3, "Vacation responder", false, false]]);
  assert.deepEqual(list.filters[1].actions, [{ type: "other", site_type: "redirect" }]);
  assert.equal(list.filters[3].match, "every_message");
  assert.deepEqual(list.filters[3].conditions, []);
  const one = await pageTool("get_filter", backend).run({ name: "newsletters" });
  assert.equal(one.filter.name, "Newsletters");
  assert.equal((await pageTool("get_filter", backend).run({ name: "Nope" })).error_kind, "not_found");
  const dupes = server({ filters: [siteFilter("Same"), siteFilter("same")] });
  assert.equal((await pageTool("get_filter", dupes).run({ name: "Same" })).error_kind, "ambiguous");
  const none = await pageTool("list_filters", server()).run({});
  assert.deepEqual(none.filters, []);
  assert.equal(backend.state.posts.length, 0);
});

test("update_filter changes only the given fields and refuses filters it cannot rewrite", async () => {
  const backend = server({ ...withInvoices(), filters: [siteFilter("Newsletters"), siteFilter("Forward boss", { actions: [{ type: "redirect", mailbox: "INBOX" }] })] });
  const result = await pageTool("update_filter", backend).run({ name: "Newsletters", changes: { enabled: false, actions: [{ type: "move_to_folder", folder: "Invoices" }] }, confirm: true });
  assert.equal(result.changed, true);
  assert.equal(result.filter.enabled, false);
  assert.deepEqual(result.filter.conditions, [{ field: "subject", header_name: null, operator: "contains", values: ["newsletter"] }]);
  assert.equal(backend.state.filters[0].actions[0].mailbox, "Invoices");
  assert.equal(backend.state.filters[1].actions[0].type, "redirect", "the other filter is untouched");
  const posts = backend.state.posts.length;
  const same = await pageTool("update_filter", backend).run({ name: "Newsletters", changes: { enabled: false }, confirm: true });
  assert.equal(same.changed, false);
  assert.equal(backend.state.posts.length, posts);
  const renamed = await pageTool("update_filter", backend).run({ name: "Newsletters", changes: { new_name: "Forward boss" }, confirm: true });
  assert.equal(renamed.error_kind, "already_exists");
  const unsupported = await pageTool("update_filter", backend).run({ name: "Forward boss", changes: { enabled: false }, confirm: true });
  assert.equal(unsupported.error_kind, "unsupported_filter");
  assert.equal(unsupported.changed, false);
  assert.equal((await pageTool("update_filter", backend).run({ name: "Missing", changes: { enabled: false }, confirm: true })).error_kind, "not_found");
  assert.equal((await pageTool("update_filter", backend).run({ name: "Newsletters", changes: {}, confirm: true })).error_kind, "invalid_input");
  assert.equal(backend.state.posts.length, posts);
});

test("delete_filter removes exactly the named filter once", async () => {
  const backend = server({ filters: [siteFilter("First"), siteFilter("Second"), siteFilter("Third")] });
  const result = await pageTool("delete_filter", backend).run({ name: "second", confirm: true });
  assert.deepEqual(result, { status: "ok", account: backend.state.account, deleted: true, name: "Second", remaining_filters: 2 });
  assert.deepEqual(backend.state.filters.map(f => f.name), ["First", "Third"]);
  assert.equal(backend.state.posts.length, 1);
  const missing = await pageTool("delete_filter", backend).run({ name: "Second", confirm: true });
  assert.equal(missing.deleted, false);
  assert.equal(backend.state.posts.length, 1);
  assert.equal((await pageTool("delete_filter", backend).run({ name: "First" })).error_kind, "invalid_input");
  const lost = server({ filters: [siteFilter("First")], deleteResponse: "network" });
  const unknown = await pageTool("delete_filter", lost).run({ name: "First", confirm: true });
  assert.equal(unknown.changed, "unknown");
  assert.equal(lost.state.posts.length, 1);
  const refused = await pageTool("delete_filter", server({ filters: [siteFilter("First")], deleteResponse: "error" })).run({ name: "First", confirm: true });
  assert.equal(refused.error_kind, "site_rejected");
  assert.equal(refused.changed, false);
});

test("vacation responder: read, create switched off, enable, no-op, and ambiguity", async () => {
  const backend = server();
  const empty = await pageTool("get_vacation_responder", backend).run({});
  assert.deepEqual(empty.responders, []);
  assert.equal(empty.active, false);
  const noop = await pageTool("set_vacation_responder", backend).run({ enabled: false, confirm: true });
  assert.equal(noop.changed, false);
  assert.equal(noop.responder, null);
  assert.equal(backend.state.posts.length, 0);
  assert.equal((await pageTool("set_vacation_responder", backend).run({ enabled: true, confirm: true })).error_kind, "invalid_input");
  const message = "Out of work from June 01 to 15; back on June 16.";
  const created = await pageTool("set_vacation_responder", backend).run({ enabled: false, message, days: 7, confirm: true });
  assert.equal(created.created, true);
  assert.equal(created.responder.enabled, false);
  assert.equal(created.responder.message, message);
  assert.equal(created.responder.applies_to, "every_message");
  assert.equal(backend.state.filters[0].actions[0].reason, message);
  assert.equal(backend.state.filters[0].join, "any");
  const enabled = await pageTool("set_vacation_responder", backend).run({ enabled: true, subject: "Away", confirm: true });
  assert.equal(enabled.changed, true);
  assert.equal(enabled.responder.enabled, true);
  assert.equal(enabled.responder.message, message, "fields not given keep their values");
  assert.equal(enabled.responder.days, 7);
  const read = await pageTool("get_vacation_responder", backend).run({});
  assert.equal(read.active, true);
  const posts = backend.state.posts.length;
  assert.equal((await pageTool("set_vacation_responder", backend).run({ enabled: true, subject: "Away", confirm: true })).changed, false);
  assert.equal(backend.state.posts.length, posts);
  const two = server({ filters: [vacationFilter("A"), vacationFilter("B"), siteFilter("Plain")] });
  assert.equal((await pageTool("set_vacation_responder", two).run({ enabled: true, confirm: true })).error_kind, "ambiguous");
  assert.equal((await pageTool("set_vacation_responder", two).run({ enabled: true, filter_name: "Plain", message: "x", confirm: true })).error_kind, "conflict");
  const chosen = await pageTool("set_vacation_responder", two).run({ enabled: true, filter_name: "B", confirm: true });
  assert.equal(chosen.responder.filter_name, "B");
  assert.equal(two.state.filters[0].enabled, false, "the other responder is untouched");
  assert.equal((await pageTool("set_vacation_responder", two).run({ enabled: true })).error_kind, "invalid_input");
});

test("create_folder creates once, is idempotent, and validates names", async () => {
  const backend = server();
  const result = await pageTool("create_folder", backend).run({ name: "Invoices", confirm: true });
  assert.deepEqual(result, { status: "ok", account: backend.state.account, created: true, folder: { id: "Invoices", name: "Invoices" } });
  assert.equal(backend.state.posts.length, 1);
  assert.equal((await pageTool("create_folder", backend).run({ name: "invoices", confirm: true })).created, false);
  assert.equal(backend.state.posts.length, 1);
  const nested = await pageTool("create_folder", backend).run({ name: "2026", parent: "Invoices", confirm: true });
  assert.equal(nested.folder.id, "Invoices.2026");
  for (const bad of [{ name: "a.b", confirm: true }, { name: "INBOX", confirm: true }, { name: "x", confirm: false }, { name: "", confirm: true }]) {
    assert.equal((await pageTool("create_folder", server()).run(bad)).error_kind, "invalid_input", JSON.stringify(bad));
  }
  assert.equal((await pageTool("create_folder", server()).run({ name: "x", parent: "Missing", confirm: true })).error_kind, "not_found");
  const refused = await pageTool("create_folder", server({ folderResponse: "error" })).run({ name: "x", confirm: true });
  assert.equal(refused.error_kind, "site_rejected");
  assert.equal(refused.changed, false);
});

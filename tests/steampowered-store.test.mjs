import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Document } from "./etsy-dom.mjs";

// Harness for the steampowered.com tools. Each page tool is re-created from execute.toString(), as the runtime does
// inside the page, and run against fabricated Steam Store markup; nothing here contacts the live site.
const NAMES = ["get_app", "get_search_results", "search_store"];
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/steampowered.com/${name}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const ORIGIN = "https://store.steampowered.com";

// Validate the JSON Schema keywords these tools use without adding a dependency.
function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every(item => conforms(schema.items, item))) return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.properties) {
      if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
      if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
    }
  }
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}

const header = `<form role="search" method="GET" action="https://store.steampowered.com/search"><input type="hidden" name="snr" value="1_4_4__12"><input type="text" name="term" value=""><button type="submit">Search</button></form>`;
const page = (body, head = "") => `<html><head><title>Fabricated</title>${head}</head><body>${header}${body}</body></html>`;

// Runs one tool on a fabricated page at url. tools lists the names the page's tool registry reports (null: unreadable).
// pages maps a fetched path to { html, url (where it landed), status }; fetched records each request.
async function run(name, input, { url, html, tools = NAMES, timers = [], pages = {}, fetched = [] }) {
  const [definition] = runInNewContext(sources[name]);
  const document = new Document(html);
  const element = Object.getPrototypeOf(document.body);
  element.checkVisibility = function () { return !this.hidden(); };
  const target = new URL(url);
  const context = {
    location: { origin: target.origin, pathname: target.pathname, search: target.search, href: target.href },
    document,
    navigator: tools === null ? {} : { modelContext: { getTools: async () => tools.map(n => ({ name: "steampowered.com." + n })) } },
    URL, URLSearchParams, JSON,
    HTMLInputElement: { prototype: element },
    Event: class { constructor(type, init = {}) { this.type = type; this.bubbles = !!init.bubbles; } },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    DOMParser: class { parseFromString(markup) { return new Document(markup); } },
    fetch: async (path, init) => {
      fetched.push({ path, init });
      const reply = pages[path] ?? { status: 404, html: "" };
      if (reply.error) throw new TypeError(reply.error);
      const status = reply.status ?? 200;
      return { status, ok: status >= 200 && status < 300, url: new URL(reply.url ?? path, ORIGIN).href, text: async () => reply.html };
    }
  };
  const execute = runInNewContext(`(${definition.execute.toString()})`, context);
  const output = JSON.parse(JSON.stringify(await execute(input)));
  assert.ok(conforms(definition.tool.outputSchema, output), "output violates outputSchema: " + JSON.stringify(output).slice(0, 400));
  return { output, document };
}

const reviewRow = (label, summary, count, desc, hidden = false) => `<a class="user_reviews_summary_row" href="#app_reviews_hash" data-tooltip-html="${desc}"${hidden ? ' style="display: none"' : ""}><div class="subtitle column">${label}:</div><div class="summary column"><span class="game_review_summary positive">${summary}</span><span class="responsive_hidden"> (${count}) </span><span class="nonresponsive_hidden responsive_reviewdesc"> - ${desc} </span></div></a>`;
const APP = page(`
  <div id="appHubAppName" class="apphub_AppName">Fabricated Farm</div>
  <div id="userReviews">
    ${reviewRow("Recent Reviews", "Very Positive", "1,204", "91% of the 1,204 user reviews in the last 30 days are positive.")}
    ${reviewRow("All Reviews", "Overwhelmingly Positive", "52,310", "96% of the 52,310 user reviews for this game are positive.")}
    ${reviewRow("Hidden Reviews", "Mixed", "3", "50% of the 3 user reviews are positive.", true)}
  </div>
  <div class="release_date"><div class="date">Mar 3, 2021</div></div>
  <div id="genresAndManufacturer"><b>Genre:</b> <span><a href="https://store.steampowered.com/genre/Indie/">Indie</a>, <a href="https://store.steampowered.com/genre/RPG/">RPG</a></span>
    <div class="dev_row"><b>Developer:</b> <a href="https://store.steampowered.com/developer/one">Studio One</a>, <a href="https://store.steampowered.com/developer/two">Studio Two</a></div>
    <div class="dev_row"><b>Publisher:</b> <a href="https://store.steampowered.com/publisher/pub">Example Publishing</a></div></div>
  <div id="game_area_purchase">
    <div class="game_area_purchase_game_wrapper"><div class="game_area_purchase_game" id="game_area_purchase_section_add_to_cart_111">
      <form name="add_to_cart_111" action="https://store.steampowered.com/cart/" method="POST"><input type="hidden" name="subid" value="111"></form>
      <h2 class="title">Buy Fabricated Farm</h2>
      <p class="game_purchase_discount_countdown">SPECIAL PROMOTION! Offer ends in 10:00:00</p>
      <div class="game_purchase_action"><div class="discount_block game_purchase_discount" data-price-final="1049" data-discount="30"><div class="discount_pct">-30%</div><div class="discount_prices"><div class="discount_original_price">$14.99</div><div class="discount_final_price">$10.49</div></div></div>
      <div class="btn_addtocart"><a role="button" href="javascript:addToCart(111);">Add to Cart</a></div></div></div></div>
    <div class="game_area_purchase_game_wrapper"><div class="game_area_purchase_game" id="game_area_purchase_section_add_to_cart_112">
      <form name="add_to_cart_112" action="https://store.steampowered.com/cart/" method="POST"><input type="hidden" name="subid" value="112"></form>
      <h2 class="title">Buy Fabricated Farm Deluxe Edition</h2>
      <div class="game_purchase_action"><div class="game_purchase_price price" data-price-final="2999">$29.99</div>
      <div class="btn_addtocart"><a role="button" href="javascript:addToCart(112);">Add to Cart</a></div></div></div></div>
    <div class="game_area_purchase_game_wrapper"><div class="game_area_purchase_game_dropdown_subscription game_area_purchase_game">
      <form name="add_bundle_to_cart_77" action="https://store.steampowered.com/cart/" method="POST"><input type="hidden" name="bundleid" value="77"></form>
      <h2 class="title"> Buy Fabricated Farm + Soundtrack <span class="bundle_label">BUNDLE <span class="bundle_label_tooltip">(?)</span></span></h2>
      <div class="game_purchase_action"><div class="btn_addtocart btn_packageinfo"><a href="https://store.steampowered.com/bundle/77/">Bundle info</a></div>
      <div class="discount_block game_purchase_discount"><div class="discount_pct">-15%</div><div class="discount_prices"><div class="discount_original_price">$19.98</div><div class="discount_final_price your_price"><div class="your_price_label">Your Price:</div><div>$16.98</div></div></div></div></div></div></div>
    <div class="game_area_purchase_game" style="display: none"><h2 class="title">Buy Hidden Package</h2><div class="game_purchase_price price">$1.00</div></div>
    <div class="game_area_dlc_section"><div class="game_area_dlc_row">Fabricated DLC $2.99</div></div>
  </div>`, `<link rel="canonical" href="https://store.steampowered.com/app/4242/Fabricated_Farm/"><meta itemprop="priceCurrency" content="USD">`);

test("registry entries match the tool files", () => {
  const entries = registry.tools.filter(t => t.domain === "steampowered.com");
  assert.deepEqual(entries.map(t => t.tool), NAMES);
  for (const entry of entries) {
    const [definition] = runInNewContext(sources[entry.tool]);
    assert.equal(entry.kind, "page");
    assert.equal(definition.kind, "page");
    assert.deepEqual([...definition.match.url_patterns], entry.url_patterns);
    assert.equal(definition.tool.annotations.readOnlyHint, entry.tool !== "search_store", entry.tool);
  }
});

test("get_app reads the purchase options and the visible review summaries", async () => {
  const { output } = await run("get_app", {}, { url: ORIGIN + "/app/4242/Fabricated_Farm/", html: APP });
  assert.equal(output.status, "ok");
  assert.deepEqual(output.app, {
    app_id: "4242", name: "Fabricated Farm", url: "https://store.steampowered.com/app/4242/Fabricated_Farm/", release_date: "Mar 3, 2021",
    coming_soon: false, developers: ["Studio One", "Studio Two"], publishers: ["Example Publishing"], genres: ["Indie", "RPG"]
  });
  assert.equal(output.currency, "USD");
  assert.deepEqual(output.purchase_options, [
    { title: "Buy Fabricated Farm", kind: "package", package_id: "111", bundle_id: null, price_text: "$10.49", price: 10.49, original_price: 14.99, discount_percent: 30, button: "Add to Cart", promotion: "SPECIAL PROMOTION! Offer ends in 10:00:00" },
    { title: "Buy Fabricated Farm Deluxe Edition", kind: "package", package_id: "112", bundle_id: null, price_text: "$29.99", price: 29.99, original_price: null, discount_percent: null, button: "Add to Cart", promotion: null },
    { title: "Buy Fabricated Farm + Soundtrack", kind: "bundle", package_id: null, bundle_id: "77", price_text: "$16.98", price: 16.98, original_price: 19.98, discount_percent: 15, button: "Bundle info", promotion: null }
  ]);
  assert.deepEqual(output.reviews, [
    { label: "Recent Reviews", summary: "Very Positive", percent_positive: 91, review_count: 1204, description: "91% of the 1,204 user reviews in the last 30 days are positive." },
    { label: "All Reviews", summary: "Overwhelmingly Positive", percent_positive: 96, review_count: 52310, description: "96% of the 52,310 user reviews for this game are positive." }
  ]);
  assert.deepEqual(output.registered_tools, { known: true, names: NAMES });
  assert.deepEqual(output.available_actions.map(a => [a.tool, a.enabled, a.input]), [["get_app", true, {}], ["get_search_results", true, { term: "Fabricated Farm" }], ["search_store", true, { term: "Fabricated Farm" }]]);
  assert.ok(output.next_steps.every(step => !step.startsWith("get_app")));
  // Steam can list a discounted edition first, so the message names no option's price.
  const editionFirst = APP.replace("Buy Fabricated Farm</h2>", "Buy Fabricated Farm Ultimate Edition</h2>");
  const edition = await run("get_app", {}, { url: ORIGIN + "/app/4242/Fabricated_Farm/", html: editionFirst });
  assert.equal(edition.output.message, "Fabricated Farm: 3 purchase option(s); Recent Reviews Very Positive, All Reviews Overwhelmingly Positive.");
});

test("get_app reads a free-to-play option and a page without reviews or prices", async () => {
  const free = page(`<div id="appHubAppName">Free Arena</div><div id="game_area_purchase"><div class="game_area_purchase_game"><h1>Play Free Arena</h1><div class="game_purchase_action"><div class="game_purchase_price price">Free To Play</div><div class="btn_addtocart"><a href="steam://run/1">Play Game</a></div></div></div></div>`);
  let { output } = await run("get_app", {}, { url: ORIGIN + "/app/1/", html: free });
  assert.deepEqual(output.purchase_options, [{ title: "Play Free Arena", kind: "other", package_id: null, bundle_id: null, price_text: "Free To Play", price: null, original_price: null, discount_percent: null, button: "Play Game", promotion: null }]);
  assert.equal(output.currency, null);
  assert.equal(output.app.url, "https://store.steampowered.com/app/1/");
  const soon = page(`<div id="appHubAppName">Future Game</div><div class="release_date"><div class="date">Coming soon</div></div><div class="game_area_comingsoon">Planned release date: Coming soon</div>`);
  ({ output } = await run("get_app", {}, { url: ORIGIN + "/app/2/Future_Game/", html: soon }));
  assert.equal(output.app.coming_soon, true);
  assert.deepEqual([output.purchase_options, output.reviews], [[], []]);
  assert.match(output.message, /no purchase options shown; no review summary shown/);
});

test("get_app reports the age check, other pages and an unrendered app page without reading them", async () => {
  let { output } = await run("get_app", {}, { url: ORIGIN + "/agecheck/app/77/", html: `<html><head><title>Mature Game</title></head><body>${header}<form method="dialog"><select name="ageYear"></select></form></body></html>` });
  assert.equal(output.status, "age_check");
  assert.equal(output.app_id, "77");
  assert.deepEqual(output.available_actions.find(a => a.tool === "search_store").input, { term: "Mature Game" });
  ({ output } = await run("get_app", {}, { url: ORIGIN + "/", html: page("<div>Welcome</div>") }));
  assert.equal(output.status, "wrong_page");
  assert.equal(output.page_type, "home");
  assert.deepEqual(output.available_actions.find(a => a.tool === "search_store"), { tool: "search_store", enabled: true, registered: true, changes_page: true, input: null, note: "Type a term into the header's Search the store box and submit it; the tab navigates to the results page. Needs the term to search for." });
  ({ output } = await run("get_app", {}, { url: ORIGIN + "/bundle/77/", html: page("<div>Bundle</div>") }));
  assert.deepEqual([output.status, output.page_type], ["wrong_page", "other"]);
  assert.deepEqual(output.available_actions.map(a => [a.tool, a.enabled, a.input]), [["get_app", true, null], ["get_search_results", true, null], ["search_store", true, null]]);
  assert.deepEqual(output.next_steps.map(step => step.split(":")[0]), ["get_search_results", "search_store"]);
  ({ output } = await run("get_app", {}, { url: ORIGIN + "/app/5/", html: page("<div>Loading</div>"), tools: null }));
  assert.equal(output.status, "not_ready");
  assert.deepEqual(output.registered_tools, { known: false, names: [] });
  assert.ok(output.available_actions.every(a => a.registered === null));
  ({ output } = await run("get_app", {}, { url: "https://help.steampowered.com/app/5/", html: page("") }));
  assert.equal(output.status, "wrong_page");
  assert.equal(output.page_type, "other");
});

const searchRow = ({ id, kind = "appid", title, released, review, final, original, pct, platforms = ["win"] }) => `<a href="https://store.steampowered.com/${kind === "bundleid" ? "bundle" : kind === "packageid" ? "sub" : "app"}/${id}/X/?snr=1_7_7_151_150_1" data-ds-${kind}="${id}" class="search_result_row ds_collapse_flag">
  <div class="responsive_search_name_combined"><div class="search_name ellipsis"><span class="title">${title}</span></div>
  <div class="search_platforms">${platforms.map(p => `<span class="platform_img ${p}"></span>`).join("")}</div>
  <div class="search_released responsive_secondrow">${released}</div>
  <div class="search_reviewscore responsive_secondrow">${review ? `<span class="search_review_summary positive" data-tooltip-html="${review}"></span>` : ""}</div>
  <div class="search_price_discount_combined"><div class="discount_block search_discount_block">${pct ? `<div class="discount_pct">${pct}</div>` : ""}<div class="discount_prices">${original ? `<div class="discount_original_price">${original}</div>` : ""}${final ? `<div class="discount_final_price">${final}</div>` : ""}</div></div></div></div></a>`;
const SEARCH = page(`<form id="advsearchform" action="https://store.steampowered.com/search/"><input type="text" id="term" name="term" value="farm"></form>
  <div id="sort_by_trigger">Lowest Price</div>
  <div class="tab_filter_control_row checked" data-param="supportedlang" data-value="english"><span class="tab_filter_control_label">English</span></div>
  <div class="tab_filter_control_row checked" data-param="supportedlang" data-value="english"><span class="tab_filter_control_label">English</span></div>
  <div id="search_result_container"><div id="search_resultsRows">
    ${searchRow({ id: "4242", title: "Fabricated Farm", released: "Mar 3, 2021", review: "Overwhelmingly Positive&lt;br&gt;96% of the 52,310 user reviews for this game are positive.", final: "$10.49", original: "$14.99", pct: "-30%", platforms: ["win", "mac"] })}
    ${searchRow({ id: "77", kind: "bundleid", title: "Fabricated Farm + Soundtrack", released: "", final: "$16.98" })}
    ${searchRow({ id: "9", title: "Free Farm", released: "Coming soon", review: "Mixed&lt;br&gt;0% of the 2 user reviews for this game are positive.", final: "Free" })}
  </div><div id="search_results_loading" style="display: none">Loading</div>
  <div class="search_pagination"><div class="search_pagination_left">showing 1 - 3 of 120</div><div class="search_pagination_right"><a href="https://store.steampowered.com/search/?term=farm&amp;page=2">2</a><a class="pagebtn" href="https://store.steampowered.com/search/?term=farm&amp;page=2">&gt;</a></div></div></div>`);

test("get_search_results reads the rendered rows, the applied sort and filters, and how to continue", async () => {
  const { output } = await run("get_search_results", { limit: 2 }, { url: ORIGIN + "/search/?term=farm&sort_by=Price_ASC", html: SEARCH });
  assert.equal(output.status, "ok");
  assert.deepEqual(output.search, { term: "farm", sort: "Lowest Price", active_filters: ["English"], total_results: 120 });
  assert.deepEqual([output.rendered_rows, output.offset, output.next_offset], [3, 0, 2]);
  assert.deepEqual(output.more_results, { available: true, next_page_url: "https://store.steampowered.com/search/?term=farm&page=2" });
  assert.deepEqual(output.results, [
    { position: 1, type: "app", id: "4242", url: "https://store.steampowered.com/app/4242/X/", title: "Fabricated Farm", release_date: "Mar 3, 2021", platforms: ["win", "mac"], review: { summary: "Overwhelmingly Positive", percent_positive: 96, review_count: 52310 }, price: { text: "$10.49", amount: 10.49, original_amount: 14.99, discount_percent: 30 } },
    { position: 2, type: "bundle", id: "77", url: "https://store.steampowered.com/bundle/77/X/", title: "Fabricated Farm + Soundtrack", release_date: null, platforms: ["win"], review: null, price: { text: "$16.98", amount: 16.98, original_amount: null, discount_percent: null } }
  ]);
  const rest = await run("get_search_results", { offset: 2 }, { url: ORIGIN + "/search/?term=farm", html: SEARCH });
  assert.deepEqual(rest.output.results.map(r => [r.position, r.review, r.price.amount]), [[3, { summary: "Mixed", percent_positive: 0, review_count: 2 }, null]]);
  assert.equal(rest.output.next_offset, null);
});

test("get_search_results stops pagination at the last page even when the response is limited", async () => {
  const last = SEARCH.replace("showing 1 - 3 of 120", "showing 118 - 120 of 120")
    .replace(/<a class="pagebtn"[^>]*>.*?<\/a>/, "")
    .replace('<div class="search_pagination">', '<div class="search_results_count">120 results match your search.</div><div class="search_pagination">');
  const { output } = await run("get_search_results", { limit: 1 }, { url: ORIGIN + "/search/?term=farm&page=40", html: last });
  assert.deepEqual(output.more_results, { available: false, next_page_url: null });
  assert.deepEqual([output.rendered_rows, output.results.length, output.next_offset], [3, 1, 1]);
});

test("get_search_results accounts for appended rows and falls back to the next-page link without a total", async () => {
  for (const [pagination, keepLink, more] of [
    ["showing 26 - 28 of 120", true, true],
    ["showing 1 - 2 of 3", true, false],
    ["showing 26 - 27 of 28", true, false],
    ["", true, true],
    ["", false, false],
  ]) {
    let html = SEARCH.replace("showing 1 - 3 of 120", pagination);
    if (!keepLink) html = html.replace(/<a class="pagebtn"[^>]*>.*?<\/a>/, "");
    const { output } = await run("get_search_results", {}, { url: ORIGIN + "/search/?term=farm", html });
    assert.deepEqual(output.more_results, { available: more, next_page_url: more ? ORIGIN + "/search/?term=farm&page=2" : null }, pagination);
  }
});

test("get_search_results does not offer hidden pagination links on infinite-scroll pages", async () => {
  const html = SEARCH.replace('<div class="search_pagination">', '<div class="search_pagination" style="display: none">');
  const { output } = await run("get_search_results", { limit: 1 }, { url: ORIGIN + "/search/?term=farm", html });
  assert.deepEqual(output.more_results, { available: true, next_page_url: null });
  assert.equal(output.next_offset, 1, "unreturned rendered rows still come first");
  assert.ok(output.next_steps.some(step => /scroll/i.test(step) && step.includes('{"offset":3}') && step.includes("omit term")));

  const complete = await run("get_search_results", {}, { url: ORIGIN + "/search/?term=farm", html: html.replace("of 120", "of 3") });
  assert.deepEqual(complete.output.more_results, { available: false, next_page_url: null });
  assert.ok(complete.output.next_steps.every(step => !/scroll/i.test(step)));
});

test("get_search_results does not offer unverified pagination links from fetched markup", async () => {
  const fetched = [];
  const { output } = await run("get_search_results", { term: "farm", limit: 100 }, {
    url: ORIGIN + "/", html: page(""), pages: { "/search/?term=farm": { html: SEARCH } }, fetched
  });
  assert.deepEqual(output.more_results, { available: true, next_page_url: null });
  assert.equal(output.next_offset, null);
  assert.equal(fetched.length, 1, "reading does not fetch another results page");
  assert.ok(output.next_steps.some(step => step.includes("Open " + ORIGIN + "/search/?term=farm") && step.includes("get_search_results with {}") && step.includes("omit term")));
});

test("get_search_results reports no results, loading, wrong pages and bad input", async () => {
  let { output } = await run("get_search_results", {}, { url: ORIGIN + "/search/?term=zzzz", html: page(`<input id="term" value="zzzz"><div id="search_result_container"><div id="search_resultsRows"></div><div class="search_results_count">0 results match your search.</div></div>`) });
  assert.deepEqual([output.status, output.rendered_rows, output.search.total_results, output.more_results.available], ["no_results", 0, 0, false]);
  ({ output } = await run("get_search_results", {}, { url: ORIGIN + "/search/?term=farm", html: page(`<div id="search_result_container"><div id="search_results_loading">Loading</div></div>`) }));
  assert.equal(output.status, "not_ready");
  ({ output } = await run("get_search_results", {}, { url: ORIGIN + "/app/4242/", html: APP }));
  assert.equal(output.status, "wrong_page");
  assert.match(output.message, /pass term/);
  for (const input of [{ limit: 0 }, { offset: -1 }, { limit: 101 }, { offset: 1.5 }, { page: 2 }]) {
    ({ output } = await run("get_search_results", input, { url: ORIGIN + "/search/?term=farm", html: SEARCH }));
    assert.equal(output.status, "invalid_input", JSON.stringify(input));
  }
});

test("search_store types into the header box and submits it once, after settling", async () => {
  const timers = [];
  const { output, document } = await run("search_store", { term: "  fabricated   farm " }, { url: ORIGIN + "/app/4242/", html: APP, timers });
  assert.deepEqual(output, { status: "navigation_scheduled", term: "fabricated farm", from_url: ORIGIN + "/app/4242/", next_step: "Wait for the search results page to load, list the tools again, then call get_search_results." });
  const box = document.querySelector('form[role="search"] input[name="term"]');
  assert.equal(box.value, "fabricated farm");
  const clicks = [];
  document.querySelector('form[role="search"] button').addEventListener("click", () => clicks.push(1));
  assert.equal(timers.length, 1);
  assert.equal(clicks.length, 0);
  timers[0].fn();
  assert.equal(clicks.length, 1);
});

test("search_store refuses bad input, other hosts and pages without the search box", async () => {
  for (const input of [{}, { term: "   " }, { term: "x".repeat(201) }, { term: "farm", sort: "price" }]) {
    const { output } = await run("search_store", input, { url: ORIGIN + "/", html: APP });
    assert.equal(output.status, "invalid_input", JSON.stringify(input));
  }
  let timers = [];
  let { output } = await run("search_store", { term: "farm" }, { url: "https://help.steampowered.com/", html: APP, timers });
  assert.equal(output.status, "wrong_page");
  ({ output } = await run("search_store", { term: "farm" }, { url: ORIGIN + "/agecheck/app/77/", html: "<html><body><form method=\"dialog\"></form></body></html>", timers }));
  assert.equal(output.status, "no_search_box");
  assert.equal(timers.length, 0);
});

test("get_app reads another app's page from any store page without leaving it", async () => {
  const fetched = [];
  const { output } = await run("get_app", { app: "https://store.steampowered.com/app/4242/Fabricated_Farm/?snr=x" }, { url: ORIGIN + "/", html: page("<div>Welcome</div>"), pages: { "/app/4242/": { html: APP, url: "/app/4242/Fabricated_Farm/" } }, fetched });
  assert.equal(output.status, "ok");
  assert.deepEqual(fetched.map(f => [f.path, f.init.credentials, f.init.method]), [["/app/4242/", "same-origin", undefined]]);
  assert.equal(output.app.app_id, "4242");
  assert.match(output.message, /^Read from https:\/\/store\.steampowered\.com\/app\/4242\/Fabricated_Farm\/ without leaving this page\./);
  assert.deepEqual(output.reviews.map(r => r.label), ["Recent Reviews", "All Reviews"], "a row the markup hides stays out");
  assert.equal(output.purchase_options.length, 3);
  for (const app of ["store.steampowered.com/app/4242/Fabricated_Farm/", "http://store.steampowered.com/app/4242/"]) {
    const other = await run("get_app", { app }, { url: ORIGIN + "/", html: page(""), pages: { "/app/4242/": { html: APP, url: "/app/4242/Fabricated_Farm/" } } });
    assert.deepEqual([other.output.status, other.output.app.app_id], ["ok", "4242"], app);
  }
  const here = [];
  const same = await run("get_app", { app: "4242" }, { url: ORIGIN + "/app/4242/Fabricated_Farm/", html: APP, fetched: here });
  assert.equal(same.output.status, "ok");
  assert.equal(here.length, 0, "the open app page is read as shown");
});

test("get_app by id reports age checks, unknown apps and bad input", async () => {
  let { output } = await run("get_app", { app: "77" }, { url: ORIGIN + "/", html: page(""), pages: { "/app/77/": { html: page("<form></form>"), url: "/agecheck/app/77/" } } });
  assert.deepEqual([output.status, output.app_id], ["age_check", "77"]);
  const login = "/login/?redir=" + encodeURIComponent(ORIGIN + "/agecheck/app/88/");
  ({ output } = await run("get_app", { app: "88" }, { url: ORIGIN + "/", html: page(""), pages: { "/app/88/": { html: page("<form></form>"), url: login } } }));
  assert.deepEqual([output.status, output.app_id], ["sign_in_required", "88"]);
  ({ output } = await run("get_app", { app: "89" }, { url: ORIGIN + "/", html: page(""), pages: { "/app/89/": { html: page("<form></form>"), url: login } } }));
  assert.deepEqual([output.status, output.app_id], ["not_found", "89"], "a sign-in page for another app");
  ({ output } = await run("get_app", { app: "4242" }, { url: ORIGIN + "/", html: page(""), pages: { "/app/4242/": { error: "Failed to fetch" } } }));
  assert.deepEqual([output.status, output.app_id], ["not_ready", "4242"]);
  ({ output } = await run("get_app", { app: "99999999" }, { url: ORIGIN + "/", html: page(""), pages: { "/app/99999999/": { html: page("<div>Welcome</div>"), url: "/" } } }));
  assert.deepEqual([output.status, output.app_id], ["not_found", "99999999"]);
  for (const app of ["", "abc", "https://evil.example/app/1/", "evil.example/store.steampowered.com/app/1/", "ftp://store.steampowered.com/app/1/", "https://store.steampowered.com/sub/1/", 7]) {
    const fetched = [];
    ({ output } = await run("get_app", { app }, { url: ORIGIN + "/", html: page(""), fetched }));
    assert.equal(output.status, "invalid_input", JSON.stringify(app));
    assert.equal(fetched.length, 0);
  }
  ({ output } = await run("get_app", { app: "1", extra: true }, { url: ORIGIN + "/", html: page("") }));
  assert.equal(output.status, "invalid_input");
});

test("get_app distinguishes failed HTTP requests from missing apps", async () => {
  for (const [status, expected] of [[403, "not_ready"], [500, "not_ready"], [503, "not_ready"], [429, "not_ready"], [404, "not_found"], [410, "not_found"]]) {
    const { output } = await run("get_app", { app: "4242" }, {
      url: ORIGIN + "/", html: page(""), pages: { "/app/4242/": { status, html: "" } }
    });
    assert.deepEqual([output.status, output.app_id], [expected, "4242"], "HTTP " + status);
  }
});

test("get_search_results reads a term's results from any store page without leaving it", async () => {
  const fetched = [];
  const hidden = SEARCH.replace("<a href=\"https://store.steampowered.com/app/4242/", "<a style=\"display: none\" href=\"https://store.steampowered.com/app/4242/");
  assert.notEqual(hidden, SEARCH);
  const { output } = await run("get_search_results", { term: " farm ", limit: 2 }, { url: ORIGIN + "/app/4242/", html: APP, pages: { "/search/?term=farm": { html: hidden } }, fetched });
  assert.equal(output.status, "ok");
  assert.deepEqual(fetched.map(f => f.path), ["/search/?term=farm"]);
  assert.equal(output.search.term, "farm");
  assert.match(output.message, /^Read from https:\/\/store\.steampowered\.com\/search\/\?term=farm without leaving this page\./);
  assert.deepEqual([output.rendered_rows, output.results.map(r => r.id)], [2, ["77", "9"]], "a row the markup hides stays out");
  const failed = await run("get_search_results", { term: "farm" }, { url: ORIGIN + "/", html: page(""), pages: { "/search/?term=farm": { status: 429, html: "" } } });
  assert.equal(failed.output.status, "not_ready");
  const offline = await run("get_search_results", { term: "farm" }, { url: ORIGIN + "/", html: page(""), pages: { "/search/?term=farm": { error: "Failed to fetch" } } });
  assert.equal(offline.output.status, "not_ready");
  for (const term of ["", "   ", "x".repeat(201), 3]) assert.equal((await run("get_search_results", { term }, { url: ORIGIN + "/", html: page("") })).output.status, "invalid_input");
});

test("get_search_results says a signed-in account's hide preferences are not applied to a term's fetched rows", async () => {
  const config = signedIn => `<div id="application_config" style="display: none;" data-userinfo="{&quot;logged_in&quot;:${signedIn},&quot;country_code&quot;:&quot;US&quot;}"></div>`;
  const read = async (signedIn, html = SEARCH) => (await run("get_search_results", { term: "farm" }, { url: ORIGIN + "/", html: page(config(signedIn)), pages: { "/search/?term=farm": { html } } })).output;
  let output = await read(true);
  assert.equal(output.status, "ok");
  assert.match(output.message, /signed in, and Steam applies its hide owned, ignored and wishlisted preferences only on the open search page/);
  assert.ok(output.next_steps.some(step => step.startsWith("Open https://store.steampowered.com/search/?term=farm") && step.endsWith("The open page also applies this account's hide preferences.")), output.next_steps.join("\n"));
  const last = await read(true, SEARCH.replace("showing 1 - 3 of 120", "showing 1 - 3 of 3"));
  assert.equal(last.more_results.available, false);
  assert.ok(last.next_steps.some(step => step.startsWith("To see the rows with this account's hide preferences applied, open https://store.steampowered.com/search/?term=farm")), last.next_steps.join("\n"));
  output = await read(false);
  assert.doesNotMatch(output.message, /signed in/);
  assert.ok(!output.next_steps.some(step => step.includes("hide preferences")));
});

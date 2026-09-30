import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import {Document} from './etsy-dom.mjs';

const names = ['search_rentals', 'get_listing', 'prepare_contact'];
const sources = Object.fromEntries(names.map(name => [name, readFileSync(new URL(`../domains/streeteasy.com/${name}.js`, import.meta.url), 'utf8')]));
const url = 'https://streeteasy.com/building/fabricated-house/2a';
const html = `<html><body><section data-testid="home-info-section"><h1 data-testid="homeAddress">123 Example Street #2A</h1><div data-testid="priceInfo">$3,100 for rent</div><div data-testid="propertyDetails">2 beds 1 bath</div></section><section data-testid="about-section">About example</section><section data-testid="home-features-section"><ul><li>Hardwood floors</li></ul></section><section data-testid="building-amenities-section"><ul><li>Elevator</li></ul></section><div data-testid="rentalListingSpec-available">Available now</div><button>Request a tour</button><button>Ask a question</button><script type="application/ld+json">{"@graph":[{"@type":"ItemPage","about":{"@type":"RealEstateListing","description":"Fabricated public description.","secret":"DO_NOT_RETURN"}}]}</script><style>DO_NOT_RETURN</style></body></html>`;

function documentFrom(text) {
  const doc = new Document(text);
  for (const element of doc.querySelectorAll('*')) element.remove = function() { this.parentNode.childNodes = this.parentNode.childNodes.filter(e => e !== this); };
  return doc;
}

function conforms(schema, value) {
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if ('const' in schema && schema.const !== value) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(t => t === 'null' ? value === null : t === 'integer' ? Number.isInteger(value) : t === 'array' ? Array.isArray(value) : t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === t)) return false;
  if (typeof value === 'string' && (value.length > (schema.maxLength ?? Infinity) || value.length < (schema.minLength ?? 0) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false;
  if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (Array.isArray(value) && (value.length > (schema.maxItems ?? Infinity) || (schema.items && !value.every(v => conforms(schema.items, v))))) return false;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.required?.some(k => !Object.hasOwn(value, k))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(k => !(k in schema.properties))) return false;
    if (Object.entries(schema.properties ?? {}).some(([k,s]) => k in value && !conforms(s, value[k]))) return false;
  }
  return true;
}

const node = {id:'7654321',street:'123 Example Street',unit:'2A',areaName:'Example area',buildingType:'RENTAL',bedroomCount:2,fullBathroomCount:1,halfBathroomCount:1,price:3100,totalMonthlyPrice:null,status:'ACTIVE',urlPath:'/building/fabricated-house/2a',secret:'DO_NOT_RETURN'};
function harness(name, options = {}) {
  const requests = [];
  let domReads = 0, clicks = 0;
  const doc = documentFrom(options.html ?? html);
  for (const button of doc.querySelectorAll('button')) button.addEventListener('click', () => clicks++);
  const document = new Proxy(doc, {get(target, key) { if (key === 'querySelector' || key === 'querySelectorAll') return (...args) => { domReads++; return target[key](...args); }; return target[key]; }});
  const context = {
    location:new URL(options.start ?? 'https://streeteasy.com/'), document, URL, Date,
    DOMParser:class { parseFromString(text) { return documentFrom(text); } },
    crypto:{randomUUID:() => 'fabricated-search-token'},getComputedStyle:() => ({visibility:'visible'}),
    fetch:async (href, init = {}) => {
      requests.push({href,init});
      if (options.throwFetch) throw new Error('DO_NOT_RETURN');
      const isApi = href === 'https://api-v6.streeteasy.com/';
      const status = options.httpStatus ?? 200;
      const body = options.body ?? (isApi ? options.apiBody ?? JSON.stringify({data:{searchRentals:{search:{criteria:options.criteria ?? 'area:302|beds:2-2|price:2000-4000|status:open'},totalCount:options.totalCount ?? 2,edges:options.edges ?? [{node}]}},secret:'DO_NOT_RETURN'}) : name === 'search_rentals' ? '<script>"criteria":"area:302|status:open"</script>' : options.html ?? html);
      return {ok:status >= 200 && status < 300,status,url:options.redirect ?? (isApi ? href : name === 'get_listing' ? url : href),text:async () => body};
    }
  };
  const [definition] = runInNewContext('(' + sources[name] + ')', context);
  return {definition,requests,get domReads() {return domReads;},get clicks() {return clicks;},async invoke(input, signal) { const result = JSON.parse(JSON.stringify(await definition.execute(input,{signal}))); assert.ok(conforms(definition.tool.outputSchema,result),JSON.stringify(result)); return result; }};
}
const search = {location:'williamsburg',beds:2,min_price:2000,max_price:4000,page_size:2};
const prep = {listing_url:url,intent:'question',message:'Is this listing available?'};

test('all definitions are self-contained page tools with explicit contracts', () => {
  for (const name of names) {
    const h = harness(name);
    assert.equal(h.definition.kind,'page');
    assert.equal(h.definition.tool.name,name);
    assert.equal(h.definition.tool.annotations.readOnlyHint,true);
    assert.equal(h.definition.tool.inputSchema.additionalProperties,false);
    assert.ok(h.definition.tool.outputSchema);
  }
});

test('malformed inputs are rejected before requests or DOM interaction', async () => {
  const cases = {
    search_rentals:[null,[],{}, {...search,location:'../../my/settings'}, {...search,confirmed:true}, {...search,min_price:5000}, {...search,page:0}, {...search,page_size:21}, {...search,beds:'2'}, {...search,status:'sold'}],
    get_listing:[null,[],{}, {url:'https://evil.invalid/building/example/2a'}, {url:url+'?token=secret'}, {url:'https://streeteasy.com/my/settings'}, {url,confirmed:true}],
    prepare_contact:[null,[],{}, {...prep,message:' '}, {...prep,intent:'apply'}, {...prep,confirmed:true}, {...prep,message:'x'.repeat(2001)}, {...prep,listing_url:url+'#contact'}]
  };
  for (const [name, inputs] of Object.entries(cases)) for (const input of inputs) {
    const h = harness(name,{start:url});
    assert.equal((await h.invoke(input)).status,'invalid_input');
    assert.equal(h.requests.length,0);assert.equal(h.domReads,0);assert.equal(h.clicks,0);
  }
});

test('unrelated origins and auxiliary hosts fail before interaction', async () => {
  for (const start of ['https://example.invalid/','https://auth.streeteasy.com/','https://api-v6.streeteasy.com/']) for (const [name,input] of [['search_rentals',search],['get_listing',{url}],['prepare_contact',prep]]) {
    const h=harness(name,{start}); assert.equal((await h.invoke(input)).status,'wrong_page');assert.equal(h.requests.length,0);assert.equal(h.domReads,0);
  }
});

test('search sends only bounded observed read queries and allowlists output', async () => {
  const h=harness('search_rentals');const r=await h.invoke(search);
  assert.equal(r.status,'ok');assert.equal(r.results.length,1);assert.equal(r.results[0].baths,1.5);assert.equal(r.results[0].price_kind,'base_rent');
  assert.equal(r.has_more,false);assert.equal(h.requests.length,2);
  const request=JSON.parse(h.requests[1].init.body);
  assert.equal(request.variables.input.perPage,2);assert.equal(request.variables.input.sorting.direction,'ASCENDING');
  assert.equal(h.requests[0].init.credentials,'include');assert.equal(h.requests[1].init.credentials,'include');
  assert.match(request.query,/query GetListingRental/);assert.doesNotMatch(request.query,/mutation/);
  assert.equal(JSON.stringify(r).includes('DO_NOT_RETURN'),false);
});

test('search preserves requested pagination and rented/total-monthly semantics', async () => {
  const h=harness('search_rentals',{criteria:'area:302|status:rented',totalCount:42,edges:[{node:{...node,status:'RENTED',totalMonthlyPrice:3150}}]});
  const r=await h.invoke({location:'williamsburg',status:'rented',page:2,page_size:3});
  assert.equal(r.page,2);assert.equal(r.has_more,true);assert.equal(r.results[0].price_kind,'total_monthly');
  assert.equal(JSON.parse(h.requests[1].init.body).variables.input.page,2);
});

test('silent filter drops, malformed results and unsafe URLs fail closed', async () => {
  const options=[{criteria:'area:302|status:open'},{edges:[{node:{...node,urlPath:'/building/example/2a?session=private'}}]},{edges:[{node:{...node,status:'RENTED'}}]},{edges:[{}]},{totalCount:-1},{edges:Array(3).fill({node})}];
  for (const option of options) {
    const r=await harness('search_rentals',option).invoke(search);
    assert.ok(['filter_not_applied','site_changed'].includes(r.status));
  }
  assert.equal((await harness('search_rentals',{totalCount:0,edges:[]}).invoke(search)).status,'no_results');
  assert.equal((await harness('search_rentals',{apiBody:'not JSON'}).invoke(search)).status,'site_changed');
  assert.equal((await harness('search_rentals',{apiBody:'captcha challenge'}).invoke(search)).status,'blocked');
  assert.equal((await harness('search_rentals',{edges:[{node:{...node,id:7654321}}]}).invoke(search)).status,'site_changed');
});

test('HTTP denials, throttles, challenges and unexpected redirects are not empty success', async () => {
  for (const name of ['search_rentals','get_listing']) for (const [httpStatus,expected] of [[403,'blocked'],[429,'rate_limited'],[401,'login_required'],[404,name === 'search_rentals' ? 'location_not_found' : 'not_found']]) {
    assert.equal((await harness(name,{httpStatus}).invoke(name === 'search_rentals' ? search : {url})).status,expected);
  }
  for (const name of ['search_rentals','get_listing']) {
    const input=name === 'search_rentals' ? search : {url};
    assert.equal((await harness(name,{body:'<html><body>Press and hold captcha</body></html>'}).invoke(input)).status,'blocked');
    assert.equal((await harness(name,{redirect:'https://auth.streeteasy.com/login?token=private'}).invoke(input)).status,'blocked');
    assert.equal((await harness(name,{throwFetch:true}).invoke(input)).status,'network_error');
  }
});

test('detail reads only allowlisted public fields, strips CSS and respects price gates', async () => {
  const h=harness('get_listing');const r=await h.invoke({url});assert.equal(r.status,'ok');assert.equal(r.listing.price,3100);
  assert.equal(r.listing.description,'Fabricated public description.');assert.deepEqual(r.listing.home_features,['Hardwood floors']);
  assert.equal(JSON.stringify(r).includes('DO_NOT_RETURN'),false);assert.equal(h.requests.length,1);
  const gated=html.replace('$3,100 for rent','Sign in to view price');const g=await harness('get_listing',{html:gated}).invoke({url});
  assert.equal(g.listing.price,null);assert.equal(g.listing.price_gated,true);
  const bounded=html.replace('Fabricated public description.','x'.repeat(9000));assert.equal((await harness('get_listing',{html:bounded}).invoke({url})).listing.description.length,6000);
});

test('contact draft checks exact page/control and never clicks, fills or sends', async () => {
  for (const intent of ['question','tour']) {
    const h=harness('prepare_contact',{start:url});const r=await h.invoke({...prep,intent});assert.equal(r.status,'ok');assert.equal(r.submitted,false);
    assert.equal(r.execution_blocker,'trusted_human_approval_unavailable');assert.equal(h.requests.length,0);assert.equal(h.clicks,0);
  }
  assert.equal((await harness('prepare_contact').invoke(prep)).status,'wrong_page');
  for (const changed of [html.replace('<button>Ask a question</button>',''),html.replace('<button>Ask a question</button>','<button disabled>Ask a question</button>'),html+'<button>Ask a question</button>']) {
    assert.equal((await harness('prepare_contact',{start:url,html:changed}).invoke(prep)).status,'site_changed');
  }
});

test('cancellation is honored before interaction and signal is passed to reads', async () => {
  for (const [name,input] of [['search_rentals',search],['get_listing',{url}],['prepare_contact',prep]]) {
    const h=harness(name,{start:url});assert.equal((await h.invoke(input,{aborted:true})).status,'canceled');assert.equal(h.requests.length,0);assert.equal(h.domReads,0);
  }
  const signal={aborted:false};const h=harness('get_listing');await h.invoke({url},signal);assert.equal(h.requests[0].init.signal,signal);
});

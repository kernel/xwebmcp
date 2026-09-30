[
{
  "kind": "page",
  "match": {
    "url_patterns": [
      "https://streeteasy.com/*",
      "https://*.streeteasy.com/*"
    ]
  },
  "tool": {
    "name": "get_listing",
    "description": "Read a public rental or sale listing using a canonical StreetEasy listing URL or /rental/<id> /sale/<id>. Fetches HTML from the current authorized session without navigation. Returns visible price and property facts only; gated prices remain null. Does not save, contact, tour, apply, generate reports or return account data.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "url": {
          "type": "string",
          "maxLength": 400,
          "pattern": "^https://streeteasy\\.com/(?:rental/[1-9][0-9]{0,11}|sale/[1-9][0-9]{0,11}|building/[a-z0-9_-]+/[a-z0-9_-]+)$"
        }
      },
      "required": [
        "url"
      ]
    },
    "outputSchema": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "status": {
              "enum": [
                "invalid_input",
                "wrong_page",
                "blocked",
                "login_required",
                "rate_limited",
                "not_found",
                "location_not_found",
                "filter_not_applied",
                "no_results",
                "site_changed",
                "network_error",
                "canceled"
              ]
            }
          },
          "required": [
            "status"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "status": {
              "const": "ok"
            },
            "observed_at": {
              "type": "string",
              "maxLength": 40
            },
            "listing": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "url": {
                  "type": "string",
                  "maxLength": 400
                },
                "address": {
                  "type": "string",
                  "maxLength": 200
                },
                "price": {
                  "type": [
                    "number",
                    "null"
                  ]
                },
                "price_label": {
                  "type": "string",
                  "maxLength": 200
                },
                "price_gated": {
                  "type": "boolean"
                },
                "property_details": {
                  "type": "string",
                  "maxLength": 500
                },
                "description": {
                  "type": "string",
                  "maxLength": 6000
                },
                "available": {
                  "type": "string",
                  "maxLength": 120
                },
                "days_on_market": {
                  "type": "string",
                  "maxLength": 120
                },
                "home_features": {
                  "type": "array",
                  "maxItems": 40,
                  "items": {
                    "type": "string",
                    "maxLength": 120
                  }
                },
                "building_amenities": {
                  "type": "array",
                  "maxItems": 40,
                  "items": {
                    "type": "string",
                    "maxLength": 120
                  }
                }
              },
              "required": [
                "url",
                "address",
                "price",
                "price_label",
                "price_gated",
                "property_details",
                "description",
                "available",
                "days_on_market",
                "home_features",
                "building_amenities"
              ]
            }
          },
          "required": [
            "status",
            "observed_at",
            "listing"
          ]
        }
      ]
    },
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": true
    }
  },
  execute: async function(input, {signal} = {}) {
    const fail = status => ({status});
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.url !== 'string' || input.url.length > 400 || !/^https:\/\/streeteasy\.com\/(?:rental\/[1-9][0-9]{0,11}|sale\/[1-9][0-9]{0,11}|building\/[a-z0-9_-]+\/[a-z0-9_-]+)$/.test(input.url)) return fail('invalid_input');
    if (location.origin !== 'https://streeteasy.com') return fail('wrong_page');
    if (signal?.aborted) return fail('canceled');
    try {
      const response = await fetch(input.url, {credentials:'include',signal});
      if (!response.ok) return fail(response.status === 404 ? 'not_found' : response.status === 429 ? 'rate_limited' : response.status === 401 ? 'login_required' : response.status === 403 ? 'blocked' : 'site_changed');
      const url = new URL(response.url);
      if (url.href.length > 400 || url.origin !== location.origin || !/^\/(?:building\/[a-z0-9_-]+\/[a-z0-9_-]+|rental\/[1-9][0-9]{0,11}|sale\/[1-9][0-9]{0,11})$/.test(url.pathname) || url.search || url.hash) return fail('blocked');
      const html = await response.text();
      if (html.length > 3000000) return fail('site_changed');
      const doc = new DOMParser().parseFromString(html,'text/html');
      for (const el of doc.querySelectorAll('style,script:not([type="application/ld+json"])')) el.remove();
      const text = (id, limit = 200) => (doc.querySelector('[data-testid="' + id + '"]')?.textContent ?? '').replace(/\s+/g,' ').trim().slice(0,limit);
      const address = text('homeAddress');
      if (!address || !doc.querySelector('[data-testid="home-info-section"]')) return fail(/captcha|press.*hold|access denied|verify you are human/i.test(doc.body.textContent) ? 'blocked' : 'site_changed');
      const priceLabel = text('priceInfo') || text('saleInfo');
      const gated = /sign in|log in/i.test(priceLabel);
      const match = /\$([0-9][0-9,]*(?:\.[0-9]+)?)/.exec(priceLabel);
      const features = id => [...(doc.querySelector('[data-testid="' + id + '"]')?.querySelectorAll('li') ?? [])].map(e => e.textContent.replace(/\s+/g,' ').trim().slice(0,120)).filter(Boolean).slice(0,40);
      let description = text('about-section',6000);
      for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
        let data;
        try { data = JSON.parse(script.textContent); } catch { continue; }
        const items = Array.isArray(data['@graph']) ? data['@graph'] : [data];
        const item = items.find(i => i['@type'] === 'ItemPage' && i.about?.['@type'] === 'RealEstateListing');
        if (typeof item?.about.description === 'string') { description = item.about.description.slice(0,6000); break; }
      }
      if (signal?.aborted) return fail('canceled');
      return {status:'ok',observed_at:new Date().toISOString(),listing:{url:url.origin + url.pathname,address,price:gated || !match ? null : Number(match[1].replace(/,/g,'')),price_label:priceLabel,price_gated:gated,property_details:text('propertyDetails',500),description,available:text('rentalListingSpec-available',120),days_on_market:text('rentalListingSpec-daysOnMarket',120),home_features:features('home-features-section'),building_amenities:features('building-amenities-section')}};
    } catch {
      return fail(signal?.aborted ? 'canceled' : 'network_error');
    }
  }
}
]

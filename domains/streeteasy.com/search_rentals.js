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
    "name": "search_rentals",
    "description": "Search public StreetEasy rentals from a streeteasy.com page without navigating. location is a single StreetEasy area slug (e.g. manhattan, williamsburg), not a free-text address. Returns up to 20 rows per page, sorted by ascending price; listing_id can be used with /rental/<id>. Prices are USD and distinguish base rent from total monthly price. No saves, alerts, contact or application submission.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "location": {
          "type": "string",
          "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$",
          "maxLength": 80
        },
        "min_price": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1000000
        },
        "max_price": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1000000
        },
        "beds": {
          "type": "integer",
          "minimum": 0,
          "maximum": 10
        },
        "status": {
          "enum": [
            "active",
            "rented"
          ]
        },
        "page": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50
        },
        "page_size": {
          "type": "integer",
          "minimum": 1,
          "maximum": 20
        }
      },
      "required": [
        "location"
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
            "search_url": {
              "type": "string",
              "maxLength": 500
            },
            "criteria": {
              "type": "string",
              "maxLength": 500
            },
            "total_count": {
              "type": "integer",
              "minimum": 0
            },
            "page": {
              "type": "integer"
            },
            "page_size": {
              "type": "integer"
            },
            "has_more": {
              "type": "boolean"
            },
            "results": {
              "type": "array",
              "maxItems": 20,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "listing_id": {
                    "type": "string",
                    "pattern": "^[1-9][0-9]{0,11}$"
                  },
                  "address": {
                    "type": "string",
                    "maxLength": 200
                  },
                  "unit": {
                    "type": "string",
                    "maxLength": 80
                  },
                  "neighborhood": {
                    "type": "string",
                    "maxLength": 200
                  },
                  "building_type": {
                    "type": "string",
                    "maxLength": 80
                  },
                  "beds": {
                    "type": [
                      "number",
                      "null"
                    ]
                  },
                  "baths": {
                    "type": [
                      "number",
                      "null"
                    ]
                  },
                  "price": {
                    "type": [
                      "number",
                      "null"
                    ]
                  },
                  "total_monthly_price": {
                    "type": [
                      "number",
                      "null"
                    ]
                  },
                  "price_kind": {
                    "enum": [
                      "base_rent",
                      "total_monthly"
                    ]
                  },
                  "listing_status": {
                    "type": "string",
                    "maxLength": 80
                  },
                  "url": {
                    "type": "string",
                    "maxLength": 400
                  }
                },
                "required": [
                  "listing_id",
                  "address",
                  "unit",
                  "neighborhood",
                  "building_type",
                  "beds",
                  "baths",
                  "price",
                  "total_monthly_price",
                  "price_kind",
                  "listing_status",
                  "url"
                ]
              }
            }
          },
          "required": [
            "status",
            "observed_at",
            "search_url",
            "criteria",
            "total_count",
            "page",
            "page_size",
            "has_more",
            "results"
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
    const keys = ['location', 'min_price', 'max_price', 'beds', 'status', 'page', 'page_size'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k)) || typeof input.location !== 'string' || input.location.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.location)) return fail('invalid_input');
    for (const [key, min, max] of [['min_price',0,1000000], ['max_price',0,1000000], ['beds',0,10], ['page',1,50], ['page_size',1,20]]) {
      if (input[key] !== undefined && (!Number.isInteger(input[key]) || input[key] < min || input[key] > max)) return fail('invalid_input');
    }
    if ((input.status !== undefined && !['active','rented'].includes(input.status)) || (input.min_price !== undefined && input.max_price !== undefined && input.min_price > input.max_price)) return fail('invalid_input');
    if (location.origin !== 'https://streeteasy.com') return fail('wrong_page');
    if (signal?.aborted) return fail('canceled');
    const page = input.page ?? 1, pageSize = input.page_size ?? 20;
    const status = input.status ?? 'active';
    const tokens = [];
    if (input.beds !== undefined) tokens.push('beds:' + input.beds);
    if (input.min_price !== undefined || input.max_price !== undefined) tokens.push('price:' + (input.min_price ?? '') + '-' + (input.max_price ?? ''));
    if (status === 'rented') tokens.push('status:rented');
    const searchUrl = 'https://streeteasy.com/for-rent/' + input.location + (tokens.length ? '/' + tokens.join('|') : '') + '?sort_by=price_asc';
    const httpFailure = code => code === 429 ? 'rate_limited' : code === 401 ? 'login_required' : code === 403 ? 'blocked' : code === 404 ? 'location_not_found' : 'site_changed';
    try {
      const areaResponse = await fetch('https://streeteasy.com/for-rent/' + input.location, {credentials:'include',signal});
      if (!areaResponse.ok) return fail(httpFailure(areaResponse.status));
      const areaUrl = new URL(areaResponse.url);
      if (areaUrl.origin !== location.origin) return fail('blocked');
      if (areaUrl.pathname !== '/for-rent/' + input.location || areaUrl.search) return fail('site_changed');
      const html = await areaResponse.text();
      if (html.length > 3000000) return fail('site_changed');
      const decoded = html.replace(/\\"/g, '"');
      const match = /"criteria":"area:([0-9]+)\|status:open"/.exec(decoded);
      if (!match) return fail(/captcha|press.*hold|access denied|verify you are human/i.test(html) ? 'blocked' : 'site_changed');
      const area = Number(match[1]);
      const filters = {rentalStatus:status === 'rented' ? 'RENTED' : 'ACTIVE',areas:[area]};
      const expected = ['area:' + area, 'status:' + (status === 'rented' ? 'rented' : 'open')];
      if (input.beds !== undefined) { filters.bedrooms = {lowerBound:input.beds,upperBound:input.beds}; expected.push('beds:' + input.beds + '-' + input.beds); }
      if (input.min_price !== undefined || input.max_price !== undefined) { filters.price = {lowerBound:input.min_price ?? null,upperBound:input.max_price ?? null}; expected.push('price:' + (input.min_price ?? '') + '-' + (input.max_price ?? '')); }
      const fields = 'id areaName bedroomCount buildingType fullBathroomCount halfBathroomCount price totalMonthlyPrice status street unit urlPath';
      const query = 'query GetListingRental($input: SearchRentalsInput!) { searchRentals(input: $input) { search { criteria } totalCount edges { ... on OrganicRentalEdge { node { ' + fields + ' } } ... on FeaturedRentalEdge { node { ' + fields + ' } } } } }';
      const response = await fetch('https://api-v6.streeteasy.com/', {method:'POST',credentials:'include',signal,headers:{'Content-Type':'application/json','app-version':'1.0.0',os:'web','apollographql-client-name':'srp-frontend-service','apollographql-client-version':'1.0.0'},body:JSON.stringify({query,variables:{input:{filters,page,perPage:pageSize,sorting:{attribute:'PRICE',direction:'ASCENDING'},userSearchToken:crypto.randomUUID(),adStrategy:'NONE'}}})});
      if (!response.ok) return fail(httpFailure(response.status));
      const text = await response.text();
      if (text.length > 1000000) return fail('site_changed');
      let data;
      try { data = JSON.parse(text); } catch { return fail(/captcha|press.*hold|access denied|verify you are human/i.test(text) ? 'blocked' : 'site_changed'); }
      if (data.errors?.length) return fail('site_changed');
      const result = data.data?.searchRentals;
      if (!result || typeof result.search?.criteria !== 'string' || result.search.criteria.length > 500 || !Number.isInteger(result.totalCount) || result.totalCount < 0 || !Array.isArray(result.edges) || result.edges.length > pageSize) return fail('site_changed');
      const actual = result.search.criteria.split('|').sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected.sort())) return fail('filter_not_applied');
      const clean = (v, n = 200) => typeof v === 'string' ? v.slice(0,n) : '';
      const number = v => Number.isFinite(v) && v >= 0 ? v : null;
      const results = [];
      for (const edge of result.edges) {
        const n = edge.node;
        if (!n || typeof n.id !== 'string' || !/^[1-9][0-9]{0,11}$/.test(n.id) || typeof n.urlPath !== 'string' || n.urlPath.length > 378 || !/^\/(?:building\/[a-z0-9_-]+\/[a-z0-9_-]+|rental\/[1-9][0-9]{0,11})$/.test(n.urlPath) || (n.urlPath.startsWith('/rental/') && n.urlPath !== '/rental/' + n.id) || typeof n.street !== 'string' || n.status !== filters.rentalStatus) return fail('site_changed');
        const baths = number(n.fullBathroomCount);
        results.push({listing_id:n.id,address:clean(n.street),unit:clean(n.unit,80),neighborhood:clean(n.areaName),building_type:clean(n.buildingType,80),beds:number(n.bedroomCount),baths:baths === null ? null : baths + (number(n.halfBathroomCount) ?? 0) / 2,price:number(n.price),total_monthly_price:number(n.totalMonthlyPrice),price_kind:n.totalMonthlyPrice == null ? 'base_rent' : 'total_monthly',listing_status:clean(n.status,80),url:'https://streeteasy.com' + n.urlPath});
      }
      if (signal?.aborted) return fail('canceled');
      if (!results.length && result.totalCount === 0) return fail('no_results');
      return {status:'ok',observed_at:new Date().toISOString(),search_url:searchUrl,criteria:result.search.criteria,total_count:result.totalCount,page,page_size:pageSize,has_more:page * pageSize < result.totalCount,results};
    } catch {
      return fail(signal?.aborted ? 'canceled' : 'network_error');
    }
  }
}
]

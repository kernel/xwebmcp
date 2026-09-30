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
    "name": "prepare_contact",
    "description": "Prepare a local question or tour-request draft for the exact CURRENT listing page. Does not fill fields, click controls, submit, send, schedule, hold inventory or persist a draft on StreetEasy. Caller navigates manually to listing_url first. Returns an observed control label for human handoff; execution is unavailable because the runtime has no trusted human approval path. No application submission supported.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "listing_url": {
          "type": "string",
          "maxLength": 400,
          "pattern": "^https://streeteasy\\.com/building/[a-z0-9_-]+/[a-z0-9_-]+$"
        },
        "intent": {
          "enum": [
            "question",
            "tour"
          ]
        },
        "message": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2000
        }
      },
      "required": [
        "listing_url",
        "intent",
        "message"
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
            "listing_url": {
              "type": "string",
              "maxLength": 400
            },
            "address": {
              "type": "string",
              "maxLength": 200
            },
            "intent": {
              "enum": [
                "question",
                "tour"
              ]
            },
            "message": {
              "type": "string",
              "maxLength": 2000
            },
            "control_label": {
              "enum": [
                "Ask a question",
                "Request a tour"
              ]
            },
            "submitted": {
              "const": false
            },
            "execution_blocker": {
              "const": "trusted_human_approval_unavailable"
            }
          },
          "required": [
            "status",
            "listing_url",
            "address",
            "intent",
            "message",
            "control_label",
            "submitted",
            "execution_blocker"
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
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3 || typeof input.listing_url !== 'string' || input.listing_url.length > 400 || !/^https:\/\/streeteasy\.com\/building\/[a-z0-9_-]+\/[a-z0-9_-]+$/.test(input.listing_url) || !['question','tour'].includes(input.intent) || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 2000) return fail('invalid_input');
    if (location.origin !== 'https://streeteasy.com' || location.origin + location.pathname !== input.listing_url) return fail('wrong_page');
    if (signal?.aborted) return fail('canceled');
    const address = document.querySelector('[data-testid="homeAddress"]')?.textContent.replace(/\s+/g,' ').trim().slice(0,200);
    if (!address || !document.querySelector('[data-testid="home-info-section"]')) return fail('site_changed');
    const label = input.intent === 'tour' ? 'Request a tour' : 'Ask a question';
    const controls = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === label && !b.disabled && b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden');
    if (controls.length !== 1) return fail('site_changed');
    return {status:'ok',listing_url:input.listing_url,address,intent:input.intent,message:input.message,control_label:label,submitted:false,execution_blocker:'trusted_human_approval_unavailable'};
  }
}
]

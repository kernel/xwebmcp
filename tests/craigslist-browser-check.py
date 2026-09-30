"""Optional actual-Chromium checks. Every HTTP request is intercepted; no live site access."""
import json
import pathlib
import subprocess

from playwright.sync_api import sync_playwright

repo = pathlib.Path(__file__).resolve().parents[1]
cases = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e",
    'import {searchCases} from "./tests/fixtures/craigslist-search.mjs"; console.log(JSON.stringify(searchCases()));'
], cwd=repo))
sources = {name: (repo / "domains/craigslist.org" / (name + ".js")).read_text()
           for name in ["search_listings", "get_listing", "prepare_reply"]}
evidence_source = (repo / "tests/craigslist-search-evidence.mjs").read_text().replace("export function", "function", 1)
listing_url = "https://www.craigslist.org/view/d/example-road-bicycle/FabricatedListing123"
crumbs = {"@type": "BreadcrumbList", "itemListElement": [
    {"item": "https://www.craigslist.org/area/sfbay"},
    {"item": "https://www.craigslist.org/search/area/sfbay?cat=bia"},
    {"item": listing_url}
]}
html = '<title>craigslist fixture</title><body><script type="application/ld+json">' + json.dumps(crumbs) + '</script>' + '''
<h1 class="postingtitletext"><span id="titletextonly">Example bicycle</span><span class="price">$125</span></h1>
<section id="postingbody">Fabricated private fields: fixture@example.invalid 202-555-0142</section>
<p class="postinginfo">post id: 7000000001</p><button class="reply-button">reply</button>
<script>window.__fetched_script_executed = true;</script>
<img src="https://resource.invalid/image"><iframe src="https://resource.invalid/frame"></iframe></body>'''

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"])
    try:
        context = browser.new_context()
        requests = []
        active = {"fixture": cases[0]}

        def intercept(route):
            url = route.request.url
            requests.append(url)
            if url == "https://www.craigslist.org/about/sites" or url == listing_url:
                route.fulfill(status=200, content_type="text/html", body="<title>craigslist fixture</title><body>Public fixture</body>")
            elif url.startswith("https://sapi.craigslist.org/web/v8/postings/search/full?"):
                fixture = active["fixture"]
                route.fulfill(status=fixture["http_status"], content_type="application/json", body=json.dumps(fixture["body"]),
                              headers={"access-control-allow-origin": "https://www.craigslist.org", "access-control-allow-credentials": "true"})
            else:
                route.abort()

        context.route("**/*", intercept)
        page = context.new_page()
        page.goto("https://www.craigslist.org/about/sites")
        actual_presence = page.evaluate('''() => {
          const parsed = JSON.parse(JSON.stringify({decode: undefined}));
          return {absent: !Object.hasOwn(parsed, "decode"), empty: Object.hasOwn(JSON.parse('{"decode":{}}'), "decode")};
        }''')
        assert actual_presence == {"absent": True, "empty": True}, actual_presence
        for fixture in cases:
            active["fixture"] = fixture
            requests.clear()
            result = page.evaluate('''async args => {
              const [definition] = (0, eval)("(" + args.source + ")");
              const output = await definition.execute({area:"sfbay", category:"bia", query:"fabricated bicycle"});
              const summarize = (0, eval)("(" + args.evidence + ")");
              return {output, evidence: summarize(args.body, output, args.http_status, 1)};
            }''', {"source": sources["search_listings"], "evidence": evidence_source.strip(),
                  "body": fixture["body"], "http_status": fixture["http_status"]})
            evidence = json.dumps(result["evidence"])
            assert result["output"]["status"] == fixture["status"], evidence
            if fixture["error_kind"]:
                assert result["output"]["error_kind"] == fixture["error_kind"], evidence
            assert len(requests) == 1, evidence
            assert page.url == "https://www.craigslist.org/about/sites", evidence
            print(fixture["name"] + ": " + evidence)

        requests.clear()
        invalid = page.evaluate('''async source => {
          const [definition] = (0, eval)("(" + source + ")");
          return await definition.execute({area:"sfbay",category:"bia",query:"fixture",confirmed:true});
        }''', sources["search_listings"])
        assert invalid["error_kind"] == "invalid_input" and not requests

        # Fetched HTML stays detached: scripts, images and frames must never execute/load.
        context.unroute("**/*", intercept)
        context.route("**/*", lambda route: (requests.append(route.request.url), route.abort()))
        inert = page.evaluate('''async args => {
          const original = window.fetch;
          let calls = 0;
          window.fetch = async () => { calls++; return new Response(args.html, {status:200}); };
          try {
            const [definition] = (0, eval)("(" + args.source + ")");
            const before = document.documentElement.outerHTML;
            const output = await definition.execute({url:args.url});
            return {status:output.status,calls,unchanged:before===document.documentElement.outerHTML,
              script_executed:window.__fetched_script_executed===true};
          } finally { window.fetch = original; }
        }''', {"source": sources["get_listing"], "html": html, "url": listing_url})
        page.wait_for_timeout(100)
        assert inert == {"status": "ok", "calls": 1, "unchanged": True, "script_executed": False} and not requests, inert

        context.unroute("**/*")
        context.route("**/*", intercept)
        page.goto(listing_url)
        page.set_content(html.replace('<script>window.__fetched_script_executed = true;</script>', "").replace('<img src="https://resource.invalid/image"><iframe src="https://resource.invalid/frame"></iframe>', ""))
        requests.clear()
        for style, expected in [("", "prepared"), ("opacity:0", "error"), ("visibility:hidden", "error"), ("display:none", "error")]:
            result = page.evaluate('''async args => {
              const button=document.querySelector("button.reply-button"); button.style.cssText=args.style;
              let clicks=0; button.onclick=()=>clicks++;
              const before=document.documentElement.outerHTML;
              const [definition]=(0,eval)("("+args.source+")");
              const output=await definition.execute({url:args.url,message:"Is this available?"});
              return {output,clicks,unchanged:before===document.documentElement.outerHTML};
            }''', {"source": sources["prepare_reply"], "url": listing_url, "style": style})
            assert result["output"]["status"] == expected and result["clicks"] == 0 and result["unchanged"] and not requests
            if expected == "prepared":
                assert all(result["output"][key] is False for key in ["sent", "saved", "recipient_verified"])
            else:
                assert result["output"]["error_kind"] == "reply_unavailable"
        print("CHROMIUM_FIXTURES_PASS: " + str(len(cases)) + " search cases; JSON presence, invalid input, inert HTML, reply visibility/no-actions")
    finally:
        browser.close()

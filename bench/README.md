# bench

Measures, per user intent on a site, how much more often and how much faster an agent succeeds
when the domain's read-only xwebmcp tools are registered in its Kernel browser, and where on the
site agents spend their time, so the tools can be built for the steps that need them.

Intents describe what a user wants done on the site, written without looking at the tool list.
Treatment gets whatever tools the domain has; a domain with none runs control alone, and the
report's tool backlog lists the slow steps no tool covers.

Each trial runs [pi](https://github.com/earendil-works/pi) (`pi -p --mode json`) against one
Kernel browser. Both arms get the same model, prompt, kernel MCP server, tool allowlist and
browser settings:

- **control**: a fresh browser on the intent's start URL, with nothing registered;
- **treatment**: the same, plus the domain's read-only tools at commits pinned for the run.

Both arms get the same system prompt, which tells the agent to list the page's WebMCP tools first
and fall back to Playwright or computer actions when none fits, as Kernel's docs tell customers
to instruct their agents. It never mentions xwebmcp or whether tools are registered, so a control
agent lists, finds nothing and falls back. A treatment trial that never invokes a tool still
counts as treatment; adoption is reported next to every treatment number.

## Layout

```
bench/
  tasks/<domain>/<intent>.json    one intent per file; domain.json holds per-domain settings
  schemas/                        JSON Schemas for answers
  prompts/system.md               the system prompt both arms get
  allowlist.txt                   the tools the agent gets, and no others: the kernel MCP tools and pi's read
  mcp.json                        the kernel MCP server; reads KERNEL_API_KEY
  .env.example                    keys run.mjs loads from bench/.env
  run.mjs  grade.mjs  report.mjs  lib/  test/
  results/<run_id>/               gitignored: run.json, rows.jsonl, transcripts
```

## Running

Needs the `kernel` and `pi` CLIs, Node 22.13+, git, `KERNEL_API_KEY` and the model provider's
key (such as `OPENAI_API_KEY`), from the environment or `bench/.env`. Each agent gets its own
`PI_CODING_AGENT_DIR`, so stored pi logins and MCP servers are not used.

### Sandbox

pi cuts an MCP result over 20KB, such as a long WebMCP tool list, and saves the full text to a
file, so the agent gets pi's `read` tool to open it. So that `read` cannot reach the bench's own
files, agents on Kernel browsers run in a [bubblewrap](https://github.com/containers/bubblewrap)
sandbox (`bwrap`, Linux only; `apt install bubblewrap`). It sees `/usr`, the `/etc` files DNS and
TLS need, its own processes and a fresh directory with its pi config and `TMPDIR`; not your home,
this checkout, other trials or the rest of `/tmp` and `/etc`. It shares the network. The agent gets
only `KERNEL_API_KEY` and the variables of its model's provider (`ANTHROPIC_*` for
`anthropic/...`). Node and pi installed outside `/usr`, such as under `~/.nvm`, are mounted
read-only from their own directories. Unprivileged user namespaces must be allowed, which some
distributions restrict with AppArmor; the smoke gate stops the run if `bwrap` cannot create a
sandbox or if one can see this checkout or your home.

Run it as a Hypeship service under a hold that covers the whole run; holds cannot be renewed.
This pilot is 105 trials and can take about 8 hours if every trial reaches its cap:

```sh
hypeship hold acquire --duration 12h
hypeship services create bench-pilot-1 --cwd "$PWD" \
  --command "node bench/run.mjs --run-id pilot-1 --model openai/gpt-5.4 --domain fandango.com --domain github.com --domain ipwho.is --adoption 5 --pairs 5 --slots 3"
hypeship services start bench-pilot-1
node bench/report.mjs bench/results/pilot-1 > pilot-1.md
```

| flag | meaning |
|---|---|
| `--run-id` | names `results/<run_id>/`; rerunning the same id resumes |
| `--model`, `--thinking` | `provider/model` and thinking level |
| `--domain`, `--intent` | select intents (repeatable); default is all |
| `--pairs` | pairs per intent; default is the intent's `pairs` |
| `--adoption` | treatment-only trials per domain before any pairs |
| `--slots` | jobs run in parallel |
| `--cap-sec` | per-trial time cap; default is the intent's `trial_timeout_sec` |
| `--max-budget-usd` | per-trial spend cap, default 2 |
| `--stealth` | stealth browsers for every trial |

Once the smoke gate passes, a new run writes `run.json`: intents with fixtures resolved, schemas,
tool commits, the MCP config, the pi and kernel CLI versions, and each pair's order (`AB` runs
control first, `BA` treatment first, split evenly within each intent and shuffled). On resume
`run.json` is authoritative, and the run refuses to continue if the allowlist, `mcp.json`, the
system prompt or the pi version changed. A resume reruns aborted or missing treatment-only
trials and every pair without a scored trial in both arms. One runner per run id.

### Local browsers

`--browser local` runs every trial in a Chromium on your own machine instead of a Kernel
browser, so sites see your IP and a real browser. Use it for sites whose bot protection blocks
Kernel browsers. It needs Node, pi, Go (or `--xwebmcp <path>` to an `xwebmcp` build) and npx,
the model provider's key, and git HTTPS access to this repository. It does not need
`KERNEL_API_KEY` or a Hypeship hold.

Branded Chrome ignores `--load-extension`, so use Chromium or Chrome for Testing (150 or later):

```sh
npx @puppeteer/browsers install chrome@stable    # prints the Chrome for Testing path
node bench/run.mjs --run-id local-1 --browser local --chrome "<that path>" \
  --model anthropic/claude-haiku-5-5 --thinking low --slots 2 --domain flyfrontier.com
```

Each trial gets a throwaway profile with the xwebmcp extension loaded (site access granted up
front), the WebMCP flag on, and its own `XWEBMCP_HOME`, so trials share nothing. The runner builds
`xwebmcp` from this checkout, registers the same pinned batch through the extension's bridge,
and gives the agent `xwebmcp mcp` (`list_tools`, `invoke_tool`) and Chrome DevTools MCP for
everything else (`allowlist.local.txt`, `mcp.local.json`, `prompts/system.local.md`). Chrome runs
headed; `--headless` is for machines without a display, and sites block it more often.
`--stealth` and signed-in intents are Kernel-only; a checkout intent's guard loads as a second
unpacked extension.

Local runs are a different setup from Kernel runs, and the report says so in its header. The
native messaging host manifest is written into each trial's profile, which Chromium reads on
macOS as on Linux, so nothing outside the trial's directory changes. Local mode has been run on
Linux only.

### Smoke gate

Before any trial, stopping on the first failure:

1. the hold covers the remaining jobs if every trial reaches its cap after 180s of setup (the
   hold is checked again before each job, and no job starts that it cannot outlast);
2. `KERNEL_API_KEY` is set (Kernel browsers), and on resume pi is the same version;
   with Kernel browsers, a sandbox works and can see neither this checkout nor your home;
3. a zero-tool pi run answers and reports a cost above zero (pi prices an unknown model at 0,
   which would disable the spend cap);
4. a treatment setup on the first pending intent works end to end;
5. in that browser, the tools pi declares to the model equal the allowlist;
6. each signed-in domain passes its sign-in check.

### Stages

With `--adoption N`, each domain first gets N treatment-only trials, cycling through its non-gap
intents. A domain where none of them invoked a tool, or all aborted, gets no pairs. Pairs follow,
interleaved across intents; a pair's two trials run back to back in one slot.

### A trial

1. Create a browser on the start URL, tagged with the run, arm and intent, with the intent's
   submission guard loaded if it has one. If the page is still loading after 15s, navigate
   again; then wait up to 15s for `load`.
2. Check the loaded URL is on the domain (or matches the `entry_tool`'s URL patterns, when the
   intent names one), in both arms.
3. Treatment: register the batch, confirm every tool registered and, with an `entry_tool`, that it
   is live on the tab, and on a signed-in
   domain run the sign-in check. Control: on a signed-in domain, register the batch, run the same
   check and remove the tools again; then fail if any custom tools are registered or live. Both
   arms record the page's own WebMCP tools, which both can use.
4. Wait until 10s after load in both arms, then launch the agent. The clock runs to
   `agent_settled`; the runner stops the agent at the time, turn or spend cap.
5. On a guarded intent, read the guard's count of blocked submit attempts. Grade the answer, read
   the trial's page navigations from the browser's telemetry to split its time into steps (Kernel
   browsers only), delete the browser and append a row to `rows.jsonl`. Each attempt keeps its own directory
   under `trials/<intent>/` (`p1-control`, then `p1-control-2` for a rerun), named in the row's
   `trial_dir`.

A setup failure gets up to three browsers before the trial is `aborted` (a signed-out profile
gets one). A trial is also `aborted` when the agent started without exactly the allowlisted tools
(pi waits only 10s for MCP servers), when pi gave up retrying a provider error, or on a runner
error. An aborted trial reruns its whole pair once; a pair still incomplete is left out of both
arms. The run stops after max(6, 2 × slots) aborts in a row. Ctrl-C or SIGTERM stops the agents
and deletes every browser.

## Intents

```json
{
  "id": "delta-cart-main-classic",
  "domain": "delta.com",
  "stage": "prepare",
  "prompt": "On delta.com, put the cheapest Delta Main Classic one-way fare for 1 adult from {{origin}} to {{destination}} on {{date}} in the cart, and stop on Delta's Trip Summary page ... Reply with JSON: ...",
  "fixture": {"origin": "Atlanta (ATL)", "destination": "Orlando (MCO)", "date": {"days_from_start": 28}},
  "start_url": "https://www.delta.com/",
  "answer_schema": "schemas/cart-flight.json",
  "rules": [{"path": "amount_due", "range": [1, 3000]}],
  "check": {
    "extract": {"amount_due": "Amount Due\\s*(?:USD\\s*)?\\$\\s*([\\d,]+\\.\\d{2})"},
    "rules": [{"path": "url", "matches": "/trip-summary"}, {"path": "text", "matches": "Main Classic"}],
    "same_as_answer": [{"answer": "amount_due", "end_state": "extracted.amount_due"}]
  },
  "pairs": 5, "trial_timeout_sec": 900, "max_turns": 60
}
```

- `stage` is `find`, `inspect`, `compare`, `prepare` or `gap`. A `gap` intent is one no tool
  covers; it names no tools and serves as the placebo check.
- A `prepare` intent walks a site's flow part way, such as putting a fare in Delta's cart and
  stopping on Trip Summary. Treatment also gets the domain's `actions`, its tools that change
  site state (see below). `check` grades where the agent left the browser, read from the page in
  both arms and never through the tools under test: its `rules` see the page's `url`, `title`
  and visible `text`; `extract` maps names to regexes whose first group is read from that text
  as `extracted.<name>` (an amount such as `$1,234.50` becomes a number); `fields` maps names to
  CSS selectors of inputs, read as `fields.<name>`, with `missing` and `invalid` lists of names.
  `same_as_answer` lists `{answer, end_state}` path pairs whose values must match, so the answer
  reports what is on the page.
- `steps` (optional) names the task's pages, `[{"name": "trip summary", "url_patterns":
  ["https://www.delta.com/*/trip-summary*"]}]`, for the report's step tables. Without it a step is
  the page's host and path, with id-like segments collapsed to `*`.
- `allow` (prepare intents only) lets the agent do more than the system prompt allows, with the
  same sentences added to both arms' prompts: `checkout` to add to the cart and go through
  checkout up to, never including, the button that pays or books, and `payment_details` to enter
  the details the task gives, which must be test data. An intent that allows `checkout` needs a
  `guard`, and see [Checkout intents](#checkout-intents).
- `tools` (optional, main by default) lists kernel/xwebmcp refs (or full `sha`s) to register
  from, such as a PR's branch after main. Treatment gets every tool `registry.json` lists for the
  domain at those commits whose file declares `readOnlyHint: true`; later sources replace earlier
  tools of the same name. Tool files are evaluated in a sandboxed child process. `names`
  (optional) are tools the intent expects to be used, and the run fails at start if any would not
  be registered. `entry_tool` (optional) must be live on the start page. A `pr` whose branch is
  gone resolves to `refs/pull/<pr>/head`, and the report marks it. Leave all three off a new
  intent: it describes the user's task, and the report shows which tools it used.
- `{{name}}` in `prompt` and `rules` comes from `fixture`. `{"days_from_start": n}` resolves to a
  date when the run starts. A fixed date that has passed skips the intent, or stops the run if
  the intent was selected by name; move dates tied to a film's run forward before each run.
- `rules` apply to every value a path resolves to (`[]` steps into arrays): `equals` and `in`
  (case- and whitespace-insensitive), `matches` (case-insensitive regex; fixture values match
  literally), `range`, `count`, `time` (`HH:MM`), `date` (`YYYY-MM-DD`) and `unique`.
- `agreement` (optional) compares the arms' answers within a pair. `{"path": "price", "better":
  "lower", "tolerance": 1}` counts pairs where one arm missed the cheapest fare. `{"path":
  "issues[]", "same": true}` is for one right answer that changes too often to pin in rules, and
  counts both-correct pairs whose answers differ as sets. Leave it off intents with many right
  answers.
- `opt_in` (optional) is a reason the intent runs only when named with `--intent`, such as a
  checkout intent not yet rehearsed on the live site.

`tasks/<domain>/domain.json` holds per-domain settings:

- `exclude`: read-only tools always left out, each with a reason;
- `needs_sign_in`: read-only tools that need an account, left out unless the domain has a profile;
- `actions`: tools that change site state that are safe to give the domain's `prepare` intents,
  each with a reason, such as adding to a cart or choosing a fare. Tools that sign in, pay, book
  or send stay out;
- `checkout_actions`: like `actions`, but only for intents that allow `checkout`, such as tools
  that move through checkout steps or hold a seat;
- `profile` and `signed_in_check`: see below;
- `instructions`: text added to every trial prompt on the domain, in both arms. The system prompt
  forbids adding to a cart unless the task allows it, so a domain that needs carts says so here.
  amctheatres.com uses it to name the step that creates a cart, since an AMC cart holds seats.

### Checkout intents

A `guard` is built into a small Chrome extension, uploaded to Kernel under a name taken from its
content and loaded in both arms' browsers. Its script runs in the page's own world, in every
frame, from document start, on the guard's `hosts` (Chrome match patterns):

- clicks on buttons and links whose text matches `buttons` (case-insensitive) are blocked;
- with `form_submit`, so are clicks on a form's submit buttons, form submission, `form.submit()` and
  `requestSubmit()`, and Enter in a form field (not counted, since agents press it to pick
  address suggestions);
- clicks on anything inside an element matching `selectors` (CSS), whatever its text, are blocked;
- with `requests`, a declarativeNetRequest rule blocks fetch, XHR and beacon requests whose URL
  matches it (RE2 syntax), from any frame or world;
- with `form_submit`, a declarativeNetRequest rule also blocks POST navigations started on the
  guard's hosts, which catches `form.submit()` called from Playwright's `page.evaluate`: that runs
  in an isolated world, where the page-world overrides of `submit()` are not installed.

Each blocked click or submission in the page is counted in a cookie on that host. After the trial
the runner reads the cookies of the whole browser, so an attempt counts even when the agent then
left the page, and a trial with any is `crashed`: the agent broke the rule against submitting.
Requests and navigations the network rules block are not counted. This is defense in depth, not a
guarantee, so checkout intents also use test data: a test card that cannot be charged, or a
signed-in test account that cannot pay (see "Signed-in trials"). Rehearse a new checkout intent
on the live site before running it.

`bluebottle-checkout-espresso` is the espresso task: one bag of Opascope Espresso, checkout
filled with test details and card 4242 4242 4242 4242, the ten fields read from the page.
Checkout's native `fill_payment_form` tool is the site's, so both arms can use it.
`delta-checkout-signed-in` books the cheapest Main Classic fare up to Review and Pay's Payment
section on the `bench-delta` profile, checked from the page's text. Its guard has not been checked
on Delta's live Review and Pay, so it is `opt_in`; drop that once it has been rehearsed.

### Signed-in trials

A domain with a Kernel `profile` loads it in every browser, in both arms, without saving
changes, and registers its `needs_sign_in` tools. An intent can name its own `profile` and
`signed_in_check` instead, as `delta-checkout-signed-in` does, so other intents on the domain run
signed out. Use a test account that cannot pay for anything: no saved payment method, and on a
checkout intent no balance the site could spend either (Delta: zero SkyMiles, no eCredits, gift
cards or certificates). Keep it signed in with a managed auth connection:

```sh
kernel auth connections create --domain instacart.com --profile-name bench-instacart -o json
kernel auth connections login <connection id>
```

`signed_in_check` names a read-only tool (and optional input) that returns an error when signed
out, or, with `rules`, whose output fails a rule when signed out. The smoke gate and every setup
in both arms invoke it; a signed-out trial aborts. Control registers the batch for the check and
removes it before the agent starts.
Jobs on one profile run one at a time, but server-side state such as recent searches carries
across trials and arms. A missing profile skips the domain, or stops the run if it was selected
by name.

## Grading

1. Extract an answer from the final message: the last fenced JSON block, then a trailing object,
   then `key: value` lines naming schema properties. Nothing extracted is `malformed`.
2. A schema or rule failure is `wrong`; otherwise `correct`, which means plausible, not verified.
3. For a `prepare` intent, the page must also pass the check's rules and match the answer at each
   `same_as_answer` pair, or it is `wrong`. What the runner read from the page, text included, is
   saved as `end-state.json` next to the transcript. A page that cannot be read, or a guard count
   that cannot be read, aborts the trial, so its pair runs again.

A successful call outside the allowlist, a blocked submit attempt, a pi error or a missing cost is
`crashed`; hitting a
cap is `timeout`. `node bench/grade.mjs bench/results/<run_id>/trials/<intent>/<trial>` regrades
one trial against its run's `run.json`.

## Report

`node bench/report.mjs bench/results/<run_id>` prints, per intent, over pairs with both trials
scored:

- the registered tools, drafts, and how answers are checked: `pinned` (a rule fixes a value),
  `agreement`, or `shape only`;
- per arm: correct with a Wilson interval, outcomes, fastest/median/slowest correct, median over
  all, minutes per correct answer, and treatment tool use;
- Δ correct with a Newcombe interval and an exact McNemar test over the pairs correct in one arm
  only, and over both-correct pairs the speedup (ratio of medians) and an exact sign test; the
  same over just the pairs whose treatment invoked a tool, when that is some but not all;
- per arm, the median turns, input tokens and cost per trial;
- a screening label: `no adoption`, `inconclusive`, `faster`, `slower`, `mixed` or `no signal`.
  Thresholds are in `report.mjs`; at 5 pairs a label needs all 5 to go the same way. A faster or
  slower arm is `mixed` when it was correct in 2 fewer pairs, gave the worse `better` answer in
  2 more, or the arms' `same` answers differed in 2 pairs.

Each intent with a step timeline also gets a steps table: agent seconds per trial on each page in
each arm, how many treatment trials invoked a tool there, and which tools. Tasks on domains with no
tools get their own table of control results and slowest steps. The tool backlog then lists, longest
first, the steps where control spent at least 20s per trial and treatment invoked a tool in fewer
than half its trials, or that have no tools at all.

A tool failures table lists, per tool, the treatment invocations that did not complete or whose
tool returned `status: "error"`, with their most common error messages. Then the worst label per
PR, and per run: spend over every attempt including smoke gates, the label histogram (noting
labels from `shape only` intents), median speedup, each arm's agent-minutes, turns and spend
over complete pairs, the pooled gap-intent
placebo, an order check, a start delay check, a native tools check (control trials that started
with the page's own WebMCP tools), cap calibration, and how many labels to expect
from noise.

## Not built yet

Reference answers and spot checks, a no-agent baseline, telemetry-based outcome classes,
scheduled runs, and the 30-pair verdict statistics.

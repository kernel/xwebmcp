# Tool training

Improves a domain's tools against the bench's intents, without letting a change that only fits
the bench through. Each domain in training has intents split 6 train, 2 validation and 2 test.
An improver reads only train results; a change is accepted on train and validation runs made in
the same time window as a run of the current tools; test runs once, at the end.

## A round

1. Run the current tools (the incumbent) with `--split train --split validation --feedback`, and
   build each domain's digest from its train trials with `score.mjs --split train --json`: per
   task results, failed trials with their tool calls, invocation errors, and agents' tool feedback,
   plus `node scripts/tool-metrics.mjs <domain>`.
2. An improver agent per domain gets its digest and pushes a candidate branch.
   - In a **repair** round it fixes failures and missing capabilities; code may grow when the
     candidate is more successful or faster.
   - In a **simplify** round it cuts tokens and selector brittleness, and may merge, split or
     remove tools; nothing may grow.
3. Run the incumbent and every candidate on train and validation at the same time, with
   `--tools-ref <branch> --treatment-only --feedback`.
4. Gate each candidate (rules at the top of `gate.mjs`):

   ```sh
   node bench/train/gate.mjs --incumbent results/<incumbent run> --candidate results/<candidate run> \
     --base <incumbent ref> --head <candidate ref> --domain <domain> --phase repair|simplify
   ```

   When the bot check blocks every trial of a task on one side, rerun that task for both sides and
   pass both runs (`--incumbent` and `--candidate` repeat). Merge accepted candidates into the
   incumbent; a rejected improver gets the gate's verdict and one retry.
5. After the last round, run `--split test` once for the incumbent with control, and for the
   original tools, and send every changed tool to independent QA before setting its status.

## Scripts

| script | does |
| --- | --- |
| `score.mjs` | regrades runs against the current task files and summarizes them by split, task and arm; with `--json`, also each tool's errors and feedback |
| `gate.mjs` | accepts or rejects a candidate |
| `lint-fixtures.mjs` | fails when a tool names a value from one of its domain's tasks |
| `../../scripts/tool-metrics.mjs` | tokens, branches, selectors and selector brittleness per tool |

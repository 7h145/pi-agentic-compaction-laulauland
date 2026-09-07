# Dogfooding the 7h145 fork

This is a fork of [laulauland/pi-agentic-compaction](https://github.com/laulauland/pi-agentic-compaction).
Original MIT licensing and authorship are preserved. The compatibility baseline
is [upstream PR #3](https://github.com/laulauland/pi-agentic-compaction/pull/3),
including PR #1's loader fix. Issue #2's auth fix was already in upstream main.

## Branches

- `main`: upstream snapshot; unchanged by this work.
- `7h145/pi-compat-failover`: PR #3's original commits, unchanged.
- `7h145/compaction-boundaries`: discarded history and split-turn prefix.
- `7h145/compaction-budgets`: bounded model/tool exploration and timeout.
- `7h145/summary-validation`: reject truncated, oversized or structurally incomplete summaries.
- `7h145/continuity-accounting`: evolving goals, file evidence, per-model usage.
- `7h145/dogfood-packaging`: reproducible dependencies, loader test, fork documentation.
- `7h145/integration`: merge commits combining these topics for use.

The follow-up topics are stacked: each depends on the preceding topic. For an
upstream contribution, compare a topic with its predecessor to review only that
change; rebase onto upstream as prerequisite work is accepted. Do not submit the
entire integration branch as one PR. No upstream issues or PRs were posted.

## Install from a local checkout

Tested with Pi 0.85.1 and Node 24.19.0. The declared Pi peer range is 0.85.x;
future Pi releases need another compatibility check.

Clone this fork and select `7h145/integration`, or use the supplied Git bundle
if GitHub publishing is still blocked. From the checkout:

```sh
npm ci --ignore-scripts
npm test
npm run check
pi install .
```

Remove the old `npm:pi-agentic-compaction` or original Git package entry first
if installed; do not load two compaction handlers. Reload Pi with `/reload`.
The local checkout stays in place: Pi loads the extension from there.

Use `/compaction-model` to choose the registered provider/model(s) you want to
test. OpenRouter and your LiteLLM/vLLM routes should use the exact IDs shown by Pi.
The persisted model list is ordered. The current session model is also appended
as a final candidate if it is not already selected. Check this before testing a
session that must stay on a particular provider.

## Limits

Optional global or project settings (project keys override global keys):

```json
{
  "pi-agentic-compaction": {
    "limits": {
      "maxTurns": 12,
      "maxTotalTokens": 200000,
      "timeoutMs": 180000,
      "maxContextTokens": 48000,
      "maxOutputTokens": 4096,
      "maxSummaryChars": 24000,
      "maxToolCallsPerTurn": 6
    }
  }
}
```

These are the defaults. `maxTurns` is per candidate. The elapsed-time and total
token budgets span the whole attempt, including provider failover. Context and
output limits are also capped by the candidate model's declared capacities.
Token budgets use Pi's estimates and reported usage; they are not exact billing
limits. An in-flight request may exceed an estimate. Provider-reported usage from
all completed responses, including failed candidates, is attached to a successful
compaction, with per-model breakdowns in details.

Cancellation or exhaustion installs no replacement summary and does not trigger
an implicit built-in fallback. Pi may then be unable to continue at a full
context window until you retry with suitable limits/model settings or disable
this extension. Explicitly cancelling the hook does not erase the session.

The timeout races model/tool promises and forwards the abort signal to the
provider. It cannot terminate synchronous JavaScript or force a remote provider
that ignores abort to stop billing. The virtual shell retains just-bash's
execution limits. Debug transcript logging remains disabled.

## Evaluation checklist

Start with a disposable or forked Pi session.

1. Run a normal task with a decision, a correction, one successful edit, and an
   unresolved next step. Run `/compact preserve the correction and pending work`.
   Confirm the summary keeps the latest goal and does not invent completion.
2. Continue the session, then compact a second time. Check that old constraints
   survive while the recent retained tail is not redundantly summarized.
3. Try a long tool-heavy turn and a session containing a branch summary.
4. Test a deliberately failing first provider with a working second provider.
   Confirm the warning and failover. Cancel a slow compaction and verify that no
   replacement summary was installed.
5. Inspect the JSONL compaction entry: `fromHook`, summary, retained-entry ID,
   `usage`, and `details.usageByModel`. Cost figures are whatever the provider/Pi
   reports, not independently measured invoices.

Compare against built-in compaction using the same session starting point.
Record Pi/Node versions, summarizer model, latency, usage, and any lost facts.
Automated checks cover structure, boundaries, failure handling, shell execution
and real Pi extension loading. They do not establish semantic summary quality.

File metadata records historical successful read/write/edit operations and
inherited summary metadata. It does not prove files still exist. Shell/custom
tool modifications or deletions remain evidence-based summary content, not
automatically inferred filesystem state. Whole-compaction failures have no
compaction entry to attach usage to; provider-side billing may still occur.

## Revert

Remove this local package from Pi's packages (or run `pi remove /absolute/path/to/checkout`)
and `/reload`. Pi's built-in compaction then handles future compactions.
Existing summaries remain in the session history.

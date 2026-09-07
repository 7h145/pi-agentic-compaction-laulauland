import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import extension, { withAbort } from "../index.ts";

const sections = ["Main Goal", "Session Type", "Key Decisions", "Files Modified", "Status", "Issues/Blockers", "Next Steps"];
export const summary = "## Summary\n\n" + sections.map((s, i) => `### ${i + 1}. ${s}\nPreserve the current task and its unresolved constraints.\n`).join("\n");
const message = (text: string): any => ({ role: "user", content: text, timestamp: 0 });
function response(content: any[], stopReason = "stop", tokens = 10): any {
    return { role: "assistant", content, stopReason, timestamp: 0, api: "openai-completions", provider: "test", model: "one",
        usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
            cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } } };
}
async function run(complete: (...args: any[]) => Promise<any>, limits: any = {}, preparation: any = {}, signal = new AbortController().signal) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-hook-"));
    const notices: string[] = [];
    try {
        fs.mkdirSync(path.join(cwd, ".pi"));
        fs.writeFileSync(path.join(cwd, ".pi/settings.json"), JSON.stringify({ "pi-agentic-compaction": { models: ["test/one"], limits } }));
        let handler: any;
        extension({ registerCommand() {}, on(name: string, fn: any) { if (name === "session_before_compact") handler = fn; } } as any);
        const model = { provider: "test", id: "one", contextWindow: 100_000, maxTokens: 8192 };
        const result = await handler({
            preparation: { firstKeptEntryId: "retained", tokensBefore: 100_000, messagesToSummarize: [message("current task")], turnPrefixMessages: [], ...preparation },
            branchEntries: [{ type: "message", message: message("DO NOT INCLUDE RETAINED TAIL") }],
            signal,
        }, {
            cwd, model, modelRegistry: { find: () => model, hasConfiguredAuth: () => true, complete },
            sessionManager: { getSessionId: () => "test" }, ui: { notify: (text: string) => notices.push(text) },
        });
        return { result, notices };
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

test("tool exploration is bounded by the configured turn count", async () => {
    let calls = 0;
    const { result, notices } = await run(async () => {
        calls++;
        return response([{ type: "toolCall", id: String(calls), name: "bash", arguments: { command: "jq length /conversation.json" } }], "toolUse");
    }, { maxTurns: 2 });
    assert.equal(calls, 2);
    assert.deepEqual(result, { cancel: true });
    assert.ok(notices.some(n => n.includes("turn budget")));
});

test("deadline returns even when a provider ignores cancellation", async () => {
    const { result, notices } = await run(() => new Promise(() => {}), { timeoutMs: 20 });
    assert.deepEqual(result, { cancel: true });
    assert.ok(notices.some(n => n.includes("time budget")));
});

test("abort race does not invoke an already cancelled operation", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(withAbort(controller.signal, async () => { assert.fail("must not call"); }));
});

test("context and total budgets prevent an oversized request", async () => {
    for (const limits of [{ maxContextTokens: 10 }, { maxTotalTokens: 10 }]) {
        const { result } = await run(async () => { assert.fail("must not call"); }, limits);
        assert.deepEqual(result, { cancel: true });
    }
});

test("too many tool calls fail before execution", async () => {
    const { result, notices } = await run(async () => response([
        { type: "toolCall", id: "1", name: "bash", arguments: { command: "true" } },
        { type: "toolCall", id: "2", name: "bash", arguments: { command: "true" } },
    ], "toolUse"), { maxToolCallsPerTurn: 1 });
    assert.deepEqual(result, { cancel: true });
    assert.ok(notices.some(n => n.includes("Too many")));
});

test("real virtual shell sees only prepared history and returns a summary", async () => {
    let calls = 0;
    const { result } = await run(async (_model, context, options) => {
        assert.equal(options.maxTokens, 4096);
        assert.match(context.systemPrompt, /previous decision/);
        if (calls++ === 0) return response([{ type: "toolCall", id: "read", name: "bash", arguments: { command: "jq -r '.[] | select(.role==\"user\") | .content[]? | select(.type==\"text\") | .text' /conversation.json" } }], "toolUse");
        const output = context.messages.at(-1).content[0].text;
        assert.match(output, /current task/);
        assert.doesNotMatch(output, /DO NOT INCLUDE/);
        return response([{ type: "text", text: summary }]);
    }, {}, { previousSummary: "previous decision" });
    assert.equal(result.compaction.summary, summary.trim());
    assert.equal(result.compaction.firstKeptEntryId, "retained");
    assert.equal(result.compaction.usage.totalTokens, 20);
    assert.equal(result.compaction.usage.cost.total, 0.02);
    assert.equal(result.compaction.details.usageByModel["test/one"].totalTokens, 20);
});

test("invalid limits cancel with an actionable error", async () => {
    const { result, notices } = await run(async () => { assert.fail("must not call"); }, { maxTurns: 0 });
    assert.deepEqual(result, { cancel: true });
    assert.ok(notices.some(n => n.includes("positive integer")));
});

test("truncated and structurally incomplete summaries are never installed", async () => {
    for (const [text, stop] of [[summary, "length"], ["x".repeat(300), "stop"], [summary.replace("### 6. Issues/Blockers", "### Missing"), "stop"]]) {
        const { result } = await run(async () => response([{ type: "text", text }], stop));
        assert.deepEqual(result, { cancel: true });
    }
});

test("summary size limit rejects oversized final text", async () => {
    const { result } = await run(async () => response([{ type: "text", text: summary }]), { maxSummaryChars: 100 });
    assert.deepEqual(result, { cancel: true });
});

test("latest user intent is requested without reapplying historical compact notes", async () => {
    const { result } = await run(async (_model, context) => {
        assert.match(context.systemPrompt, /latest relevant user instructions/);
        assert.match(context.systemPrompt, /explicit cancellations or replacements/);
        assert.doesNotMatch(context.systemPrompt, /## User note passed to \/compact/);
        return response([{ type: "text", text: summary }]);
    }, {}, { messagesToSummarize: [message("/compact obsolete formatting request")] });
    assert.ok(result.compaction);
});

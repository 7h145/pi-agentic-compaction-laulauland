import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension, { completeCompactionTurn, resolveCompactionModels } from "../index.ts";

const model: Model<"openai-completions"> = {
    id: "deepseek", name: "DeepSeek", provider: "local", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1",
    reasoning: true, thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
    compat: { supportsReasoningEffort: true }, contextWindow: 262144, maxTokens: 32768,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = { messages: [{ role: "user" as const, content: "Summarize", timestamp: 0 }] };

test("real Pi adapter applies existing thinkingLevelMap to the request payload", async () => {
    let authCalls = 0;
    const ctx = { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: `fresh-${++authCalls}`, headers: { "x-test": "fresh" } }) } } as unknown as ExtensionContext;
    for (const [thinking, expected] of [["low", "low"], ["medium", "high"], ["max", "max"], ["off", undefined]] as const) {
        let payload: any;
        const response = await completeCompactionTurn(ctx, { model, thinking }, context, {
            maxTokens: 4096,
            onPayload(value) { payload = value; throw new Error("captured before network"); },
        });
        assert.match(response.errorMessage ?? "", /captured before network/);
        assert.equal(payload.reasoning_effort, expected);
    }
    assert.equal(authCalls, 4);
    let payload: any;
    await completeCompactionTurn(ctx, { model: { ...model, thinkingLevelMap: { low: "backend-low" } }, thinking: "low" }, context, {
        onPayload(value) { payload = value; throw new Error("captured before network"); },
    });
    assert.equal(payload.reasoning_effort, "backend-low");
});

test("simple registry path receives effective levels; omitted thinking keeps legacy dispatch", async () => {
    const calls: unknown[] = [];
    const result: any = { stopReason: "stop" };
    const ctx = { modelRegistry: {
        complete: async () => { calls.push("legacy"); return result; },
        completeSimple: async (_model: unknown, _context: unknown, options: any) => { calls.push(options.reasoning); return result; },
    } } as unknown as ExtensionContext;
    await completeCompactionTurn(ctx, { model }, context, {});
    for (const thinking of ["low", "medium", "off"] as ModelThinkingLevel[]) {
        await completeCompactionTurn(ctx, { model, thinking }, context, {});
    }
    await completeCompactionTurn(ctx, { model: { ...model, reasoning: false }, thinking: "low" }, context, {});
    assert.deepEqual(calls, ["legacy", "low", "high", undefined, undefined]);
});

test("explicit thinking still checks refreshed auth and cancellation", async () => {
    const controller = new AbortController();
    const ctx = { modelRegistry: { getApiKeyAndHeaders: async () => { controller.abort(); return { ok: true, apiKey: "unused" }; } } } as unknown as ExtensionContext;
    await assert.rejects(completeCompactionTurn(ctx, { model, thinking: "low" }, context, { signal: controller.signal }), /cancelled/);
    const failed = { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "expired" }) } } as unknown as ExtensionContext;
    await assert.rejects(completeCompactionTurn(failed, { model, thinking: "low" }, context, {}), /expired/);
});

test("hook keeps thinking across turns, changes it on failover, and reports clamping", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-thinking-"));
    try {
        fs.mkdirSync(path.join(cwd, ".pi"));
        fs.writeFileSync(path.join(cwd, ".pi/pi-agentic-compaction.json"), JSON.stringify({ models: [
            { model: "local/deepseek", thinking: "low" }, { model: "local/fallback", thinking: "medium" },
        ] }));
        const calls: unknown[] = [];
        const notices: string[] = [];
        const ctx: any = {
            cwd, model: { ...model, id: "session" },
            modelRegistry: { find: (_provider: string, id: string) => ({ ...model, id }), hasConfiguredAuth: () => true,
                completeSimple: async (m: any, _c: any, options: any) => {
                    calls.push([m.id, options.reasoning]);
                    return { role: "assistant", content: calls.length === 1 ? [{ type: "toolCall", id: "query", name: "bash", arguments: { command: "jq length /conversation.json" } }] : [],
                        stopReason: calls.length === 1 ? "toolUse" : "error", errorMessage: "test failure", timestamp: 0,
                        usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
                }, complete: async () => { calls.push("session legacy"); throw new Error("test failure"); },
            }, sessionManager: { getSessionId: () => "test" }, ui: { notify: (s: string) => notices.push(s) },
        };
        const resolution = await resolveCompactionModels(ctx, new AbortController().signal);
        assert.deepEqual(resolution.candidates.map(c => c.thinking), ["low", "medium", undefined]);
        let handler: any;
        extension({ registerCommand() {}, on(name: string, fn: any) { if (name === "session_before_compact") handler = fn; } } as any);
        const result = await handler({ signal: new AbortController().signal, branchEntries: [], preparation: {
            firstKeptEntryId: "keep", tokensBefore: 100, messagesToSummarize: context.messages, turnPrefixMessages: [],
        } }, ctx);
        assert.deepEqual(result, { cancel: true });
        assert.deepEqual(calls, [["deepseek", "low"], ["deepseek", "low"], ["fallback", "high"], "session legacy"]);
        assert.ok(notices.some(s => s.includes("thinking: low")));
        assert.ok(notices.some(s => s.includes("thinking: high; requested: medium")));
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

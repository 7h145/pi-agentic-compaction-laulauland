import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import agenticCompactionExtension, {
    completeCompactionTurn,
    getAssistantResponseError,
    getDefaultCompactionModelIds,
    resolveCompactionModels,
    tryCompactionModelCandidates,
    type ResolvedCompactionModel,
} from "../index.ts";

function candidate(provider: string, id: string): ResolvedCompactionModel {
    return { model: { provider, id } as Model<any> };
}

test("default candidates cover OpenAI API, Codex, and GitHub Copilot providers", () => {
    assert.deepEqual(getDefaultCompactionModelIds(), [
        "cerebras/zai-glm-4.7",
        "openai/gpt-5.4-mini",
        "openai-codex/gpt-5.4-mini",
        "github-copilot/gpt-5.4-mini",
    ]);
});

test("assistant terminal errors are surfaced before processing content", () => {
    assert.equal(
        getAssistantResponseError({ stopReason: "error", errorMessage: "This operation was aborted" }),
        "This operation was aborted",
    );
    assert.equal(
        getAssistantResponseError({ stopReason: "aborted", errorMessage: undefined }),
        "Model stopped with aborted",
    );
    assert.equal(getAssistantResponseError({ stopReason: "stop", errorMessage: undefined }), undefined);
});

test("a failed model falls through to the next configured candidate", async () => {
    const candidates = [candidate("openai-codex", "gpt-5.4-mini"), candidate("github-copilot", "gpt-5.4-mini")];
    const controller = new AbortController();
    const attempts: string[] = [];
    const failures: Array<{ modelId: string; hasNext: boolean }> = [];

    const result = await tryCompactionModelCandidates(
        candidates,
        controller.signal,
        async ({ model }) => {
            const modelId = `${model.provider}/${model.id}`;
            attempts.push(modelId);
            if (model.provider === "openai-codex") {
                throw new Error("This operation was aborted");
            }
            return "summary";
        },
        (failure, hasNext) => failures.push({ modelId: failure.modelId, hasNext }),
    );

    assert.equal(result.result, "summary");
    assert.equal(result.aborted, false);
    assert.deepEqual(attempts, ["openai-codex/gpt-5.4-mini", "github-copilot/gpt-5.4-mini"]);
    assert.deepEqual(result.failures, [
        { modelId: "openai-codex/gpt-5.4-mini", error: "This operation was aborted" },
    ]);
    assert.deepEqual(failures, [{ modelId: "openai-codex/gpt-5.4-mini", hasNext: true }]);
});

test("all model failures are returned without fabricating a result", async () => {
    const candidates = [candidate("openai-codex", "gpt-5.4-mini"), candidate("github-copilot", "gpt-5.4-mini")];

    const result = await tryCompactionModelCandidates(candidates, new AbortController().signal, async ({ model }) => {
        throw new Error(`${model.provider} unavailable`);
    });

    assert.equal(result.result, undefined);
    assert.equal(result.aborted, false);
    assert.deepEqual(result.failures, [
        { modelId: "openai-codex/gpt-5.4-mini", error: "openai-codex unavailable" },
        { modelId: "github-copilot/gpt-5.4-mini", error: "github-copilot unavailable" },
    ]);
});

test("an abort stops failover before another provider is called", async () => {
    const controller = new AbortController();
    const candidates = [candidate("openai-codex", "gpt-5.4-mini"), candidate("github-copilot", "gpt-5.4-mini")];
    const attempts: string[] = [];

    const result = await tryCompactionModelCandidates(candidates, controller.signal, async ({ model }) => {
        attempts.push(model.provider);
        controller.abort();
        throw new Error("cancelled");
    });

    assert.equal(result.aborted, true);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(attempts, ["openai-codex"]);
});

test("model resolution skips registered candidates without configured auth", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agentic-compaction-test-"));
    const models = [candidate("unauthenticated", "gpt-5.4-mini").model, candidate("authenticated", "gpt-5.4-mini").model];
    const authRequests: string[] = [];

    try {
        fs.mkdirSync(path.join(cwd, ".pi"));
        fs.writeFileSync(
            path.join(cwd, ".pi", "settings.json"),
            JSON.stringify({
                "pi-agentic-compaction": {
                    models: models.map((model) => `${model.provider}/${model.id}`),
                },
            }),
        );

        const ctx = {
            cwd,
            model: undefined,
            modelRegistry: {
                find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
                hasConfiguredAuth: (model: Model<any>) => model.provider === "authenticated",
                getApiKeyAndHeaders: async (model: Model<any>) => {
                    authRequests.push(model.provider);
                    return { ok: true as const, apiKey: "token" };
                },
            },
        } as unknown as ExtensionContext;

        const result = await resolveCompactionModels(ctx, new AbortController().signal);

        assert.deepEqual(
            result.candidates.map(({ model }) => `${model.provider}/${model.id}`),
            ["authenticated/gpt-5.4-mini"],
        );
        assert.deepEqual(authRequests, []);
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test("an already-aborted resolution does not inspect configured candidates", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agentic-compaction-test-"));
    const controller = new AbortController();
    const models = [candidate("first", "gpt-5.4-mini").model, candidate("second", "gpt-5.4-mini").model];
    const inspectedModels: string[] = [];

    try {
        fs.mkdirSync(path.join(cwd, ".pi"));
        fs.writeFileSync(
            path.join(cwd, ".pi", "settings.json"),
            JSON.stringify({
                "pi-agentic-compaction": {
                    models: models.map((model) => `${model.provider}/${model.id}`),
                },
            }),
        );
        controller.abort();

        const ctx = {
            cwd,
            model: undefined,
            modelRegistry: {
                find: (provider: string, id: string) => {
                    inspectedModels.push(`${provider}/${id}`);
                    return models.find((model) => model.provider === provider && model.id === id);
                },
                hasConfiguredAuth: () => true,
            },
        } as unknown as ExtensionContext;

        const result = await resolveCompactionModels(ctx, controller.signal);

        assert.deepEqual(result.candidates, []);
        assert.deepEqual(inspectedModels, []);
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

function registerCompactionHandler(): (event: any, ctx: ExtensionContext) => Promise<any> {
    let handler: ((event: any, ctx: ExtensionContext) => Promise<any>) | undefined;
    const pi = {
        registerCommand: () => {},
        on: (eventType: string, eventHandler: (event: any, ctx: ExtensionContext) => Promise<any>) => {
            if (eventType === "session_before_compact") handler = eventHandler;
        },
    } as unknown as ExtensionAPI;

    agenticCompactionExtension(pi);
    assert.ok(handler);
    return handler;
}

function assistantResponse(model: Model<any>, options: { text?: string; error?: string }): any {
    return {
        role: "assistant",
        content: options.text ? [{ type: "text", text: options.text }] : [],
        api: model.api ?? "openai-responses",
        provider: model.provider,
        model: model.id,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: options.error ? "error" : "stop",
        errorMessage: options.error,
        timestamp: Date.now(),
    };
}

test("the compaction hook retries a terminal model error with a fresh provider", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agentic-compaction-test-"));
    const models = [candidate("openai-codex", "gpt-5.4-mini").model, candidate("github-copilot", "gpt-5.4-mini").model];
    const completionModels: string[] = [];
    const notifications: string[] = [];

    try {
        fs.mkdirSync(path.join(cwd, ".pi"));
        fs.writeFileSync(
            path.join(cwd, ".pi", "settings.json"),
            JSON.stringify({
                "pi-agentic-compaction": {
                    models: models.map((model) => `${model.provider}/${model.id}`),
                },
            }),
        );

        const ctx = {
            cwd,
            model: undefined,
            modelRegistry: {
                find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
                hasConfiguredAuth: () => true,
                getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "token" }),
                complete: async (model: Model<any>) => {
                    completionModels.push(model.provider);
                    return model.provider === "openai-codex"
                        ? assistantResponse(model, { error: "This operation was aborted" })
                        : assistantResponse(model, { text: ("## Summary\n" + ["Main Goal", "Session Type", "Key Decisions", "Files Modified", "Status", "Issues/Blockers", "Next Steps"].map((name, i) => `### ${i + 1}. ${name}\nRelevant session context.\n`).join("\n")) });
                },
            },
            sessionManager: { getSessionId: () => "session-id" },
            ui: { notify: (message: string) => notifications.push(message) },
        } as unknown as ExtensionContext;

        const result = await registerCompactionHandler()(
            {
                preparation: {
                    tokensBefore: 300_000,
                    firstKeptEntryId: "kept-entry",
                    previousSummary: undefined,
                    messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "Fix compaction" }], timestamp: 0 }],
                    turnPrefixMessages: [],
                },
                branchEntries: [
                    { type: "message", message: { role: "user", content: [{ type: "text", text: "Fix compaction" }] } },
                ],
                customInstructions: undefined,
                signal: new AbortController().signal,
            },
            ctx,
        );

        assert.deepEqual(completionModels, ["openai-codex", "github-copilot"]);
        assert.equal(result.compaction.firstKeptEntryId, "kept-entry");
        assert.match(result.compaction.summary, /^## Summary/);
        assert.ok(notifications.some((message) => message.includes("trying next model")));
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test("the compaction hook cancels instead of invoking an implicit built-in fallback", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agentic-compaction-test-"));
    const model = candidate("openai-codex", "gpt-5.4-mini").model;
    const notifications: string[] = [];

    try {
        fs.mkdirSync(path.join(cwd, ".pi"));
        fs.writeFileSync(
            path.join(cwd, ".pi", "settings.json"),
            JSON.stringify({ "pi-agentic-compaction": { models: [`${model.provider}/${model.id}`] } }),
        );

        const ctx = {
            cwd,
            model: undefined,
            modelRegistry: {
                find: () => model,
                hasConfiguredAuth: () => true,
                getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "token" }),
                complete: async () => assistantResponse(model, { error: "This operation was aborted" }),
            },
            sessionManager: { getSessionId: () => "session-id" },
            ui: { notify: (message: string) => notifications.push(message) },
        } as unknown as ExtensionContext;

        const result = await registerCompactionHandler()(
            {
                preparation: { tokensBefore: 300_000, firstKeptEntryId: "kept-entry", previousSummary: undefined, messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "Fix compaction" }], timestamp: 0 }], turnPrefixMessages: [] },
                branchEntries: [
                    { type: "message", message: { role: "user", content: [{ type: "text", text: "Fix compaction" }] } },
                ],
                customInstructions: undefined,
                signal: new AbortController().signal,
            },
            ctx,
        );

        assert.deepEqual(result, { cancel: true });
        assert.ok(notifications.some((message) => message.includes("Built-in fallback was skipped")));
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test("legacy completion resolves fresh request auth for every summarizer turn", async () => {
    const resolvedCandidate = candidate("legacy-provider", "summary-model");
    let authResolution = 0;
    const seenApiKeys: Array<string | undefined> = [];
    const ctx = {
        modelRegistry: {
            getApiKeyAndHeaders: async () => {
                authResolution += 1;
                return { ok: true as const, apiKey: `token-${authResolution}` };
            },
        },
    } as unknown as ExtensionContext;
    const legacyComplete = (async (_model: Model<any>, _context: any, options: any) => {
        seenApiKeys.push(options.apiKey);
        return assistantResponse(resolvedCandidate.model, { text: ("## Summary\n" + ["Main Goal", "Session Type", "Key Decisions", "Files Modified", "Status", "Issues/Blockers", "Next Steps"].map((name, i) => `### ${i + 1}. ${name}\nRelevant session context.\n`).join("\n")) });
    }) as Parameters<typeof completeCompactionTurn>[4];

    await completeCompactionTurn(
        ctx,
        resolvedCandidate,
        { messages: [] },
        { signal: new AbortController().signal },
        legacyComplete,
    );
    await completeCompactionTurn(
        ctx,
        resolvedCandidate,
        { messages: [] },
        { signal: new AbortController().signal },
        legacyComplete,
    );

    assert.equal(authResolution, 2);
    assert.deepEqual(seenApiKeys, ["token-1", "token-2"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { cumulativeFileOps, detectFileOpsFromConversation, addUsage, emptyUsage } from "../index.ts";

test("file tracking requires successful paired results, excludes no-ops and preserves reads", () => {
    const calls = [
        ["write", "ok.ts"], ["edit", "failed.ts"], ["edit", "noop.ts"], ["write", "unanswered.ts"], ["read", "read.ts"],
    ];
    const messages: any[] = [{ role: "assistant", content: calls.map(([name, path], i) => ({ type: "toolCall", id: String(i), name, arguments: { path } })) }];
    for (const [id, isError, text] of [["0", false, "written"], ["1", true, "failed"], ["2", false, "No changes applied"], ["4", false, "contents"]] as const) {
        messages.push({ role: "toolResult", toolCallId: id, isError, content: [{ type: "text", text }] });
    }
    assert.deepEqual(detectFileOpsFromConversation(messages), { modifiedFiles: ["ok.ts"], readFiles: ["read.ts"] });
});

test("cumulative metadata survives compaction and subsequent branch summaries", () => {
    const event: any = { preparation: { firstKeptEntryId: "kept" }, branchEntries: [
        { type: "compaction", details: { modifiedFiles: ["obsolete.ts"] } },
        { type: "compaction", details: { modifiedFiles: ["earlier.ts"], readFiles: ["now-edited.ts"] } },
        { type: "branch_summary", details: { modifiedFiles: ["branch.ts", 123], readFiles: ["read.ts"] } },
    ] };
    assert.deepEqual(cumulativeFileOps(event, { modifiedFiles: ["now-edited.ts"], readFiles: [] }), {
        modifiedFiles: ["branch.ts", "earlier.ts", "now-edited.ts"], readFiles: ["read.ts"],
    });
});

test("usage adds cache tokens and costs without mutating response usage", () => {
    const total = emptyUsage();
    const response = { ...emptyUsage(), input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100 };
    response.cost.total = 0.5;
    addUsage(total, response);
    addUsage(total, response);
    assert.equal(total.totalTokens, 200);
    assert.equal(total.cacheRead, 60);
    assert.equal(total.cost.total, 1);
    assert.equal(response.totalTokens, 100);
});

test("retained branch-summary metadata is not folded into the discarded span", () => {
    const event: any = { preparation: { firstKeptEntryId: "kept" }, branchEntries: [
        { type: "message", id: "old-kept" },
        { type: "compaction", firstKeptEntryId: "old-kept", details: { modifiedFiles: ["old.ts"] } },
        { type: "branch_summary", id: "discarded", details: { modifiedFiles: ["discarded.ts"] } },
        { type: "branch_summary", id: "kept", details: { modifiedFiles: ["retained.ts"] } },
    ] };
    assert.deepEqual(cumulativeFileOps(event, { readFiles: [], modifiedFiles: [] }).modifiedFiles, ["discarded.ts", "old.ts"]);
});

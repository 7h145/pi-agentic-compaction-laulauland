import assert from "node:assert/strict";
import test from "node:test";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { getCompactionMessages } from "../index.ts";

test("prepared history includes branch context and split prefix in order", () => {
    const history = { role: "user", content: "history", timestamp: 0 };
    const branch = { role: "branchSummary", summary: "branch decision", fromId: "branch", timestamp: 0 };
    const prefix = { role: "user", content: "ongoing task", timestamp: 0 };
    const preparation = { messagesToSummarize: [history, branch], turnPrefixMessages: [prefix], isSplitTurn: true } as any;
    assert.deepEqual(getCompactionMessages(preparation), [history, branch, prefix]);
    assert.match(JSON.stringify(convertToLlm(getCompactionMessages(preparation))), /branch decision/);
    assert.deepEqual(preparation.messagesToSummarize, [history, branch]);
});

test("repeated compaction uses only the new prepared span", () => {
    const message = (text: string): any => ({ role: "user", content: text, timestamp: 0 });
    const first = message("already summarized");
    const second = message("previously retained, now discarded");
    const latest = message("still retained");
    const event = {
        branchEntries: [first, second, latest],
        preparation: { messagesToSummarize: [second], turnPrefixMessages: [], previousSummary: "earlier decisions" },
    };
    assert.deepEqual(getCompactionMessages(event.preparation as any), [second]);
});

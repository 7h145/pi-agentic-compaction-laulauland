import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

test("current Pi's real loader registers the command and compaction handler", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compaction-loader-"));
    try {
        const loader = new DefaultResourceLoader({
            cwd: dir, agentDir: dir,
            additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
            noSkills: true, noPromptTemplates: true, noThemes: true,
        });
        await loader.reload();
        const result = loader.getExtensions();
        assert.deepEqual(result.errors, []);
        assert.equal(result.extensions.length, 1);
        assert.ok(result.extensions[0]!.commands.has("compaction-model"));
        assert.ok(result.extensions[0]!.handlers.has("session_before_compact"));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

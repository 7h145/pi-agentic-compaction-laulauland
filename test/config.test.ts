import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_LIMITS, getSettingsPaths, loadCompactionModelConfig, loadCompactionLimits, persistCompactionModelConfig } from "../index.ts";

function fixture(fn: (cwd: string, global: string, project: string) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-config-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
    const cwd = path.join(dir, "project");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(getAgentDir(), { recursive: true });
    try {
        const paths = getSettingsPaths(cwd);
        assert.equal(paths.global, path.join(getAgentDir(), "pi-agentic-compaction.json"));
        assert.equal(paths.project, path.join(cwd, ".pi", "pi-agentic-compaction.json"));
        fn(cwd, paths.global, paths.project);
    } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));

test("standalone config uses Pi's configured agent directory and ignores old settings", () => fixture((cwd, global) => {
    write(path.join(getAgentDir(), "settings.json"), { "pi-agentic-compaction": { models: ["old/global"], limits: { maxTurns: 1 } } });
    write(path.join(cwd, ".pi/settings.json"), { "pi-agentic-compaction": { models: ["old/project"] } });
    assert.equal(loadCompactionModelConfig(cwd).source, "default");
    assert.equal(loadCompactionLimits(cwd).maxTurns, DEFAULT_LIMITS.maxTurns);
    write(global, { models: ["new/global"] });
    assert.deepEqual(loadCompactionModelConfig(cwd).models, ["new/global"]);
}));

test("project models replace global models; limits merge per key", () => fixture((cwd, global, project) => {
    write(global, { models: ["test/global"], limits: { maxTurns: 8, timeoutMs: 30000 } });
    write(project, { limits: { maxTurns: 3 } });
    assert.deepEqual(loadCompactionModelConfig(cwd).models, ["test/global"]);
    assert.equal(loadCompactionLimits(cwd).maxTurns, 3);
    assert.equal(loadCompactionLimits(cwd).timeoutMs, 30000);
    write(project, { models: [] });
    assert.deepEqual(loadCompactionModelConfig(cwd).models, []);
    assert.equal(loadCompactionModelConfig(cwd).source, "project");
}));

test("picker persistence preserves limits and other config fields without touching Pi settings", () => fixture((cwd, global, project) => {
    const settings = path.join(getAgentDir(), "settings.json");
    fs.writeFileSync(settings, '{ "custom": true }\n');
    for (const [scope, file] of [["global", global], ["project", project]] as const) {
        write(file, { limits: { maxTurns: 7 }, other: "preserved" });
        assert.equal(persistCompactionModelConfig(cwd, scope, ["test/a", "test/a", "test/b"]), file);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
            limits: { maxTurns: 7 }, other: "preserved", models: ["test/a", "test/b"],
        });
    }
    assert.equal(fs.readFileSync(settings, "utf8"), '{ "custom": true }\n');
}));

test("malformed config is reported and never overwritten by picker persistence", () => fixture((cwd, _global, project) => {
    fs.writeFileSync(project, "{broken");
    assert.throws(() => loadCompactionLimits(cwd), /Failed to parse/);
    assert.throws(() => persistCompactionModelConfig(cwd, "project", ["test/a"]), /Failed to parse/);
    assert.equal(fs.readFileSync(project, "utf8"), "{broken");
}));

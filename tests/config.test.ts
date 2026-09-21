import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/core.ts";
import { loadConfig, resolveConfigPath } from "../src/config.ts";

test("config path honors PI_GIBBON_CONFIG and otherwise uses the agent directory", () => {
	assert.equal(resolveConfigPath({ PI_GIBBON_CONFIG: "/custom/gibbon.json" }, "/agent"), "/custom/gibbon.json");
	assert.equal(resolveConfigPath({}, "/agent"), join("/agent", "pi-gibbon.json"));
});

test("missing config uses defaults and a valid external config is parsed", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-gibbon-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	assert.deepEqual(await loadConfig(join(root, "missing.json")), DEFAULT_CONFIG);

	const path = join(root, "pi-gibbon.json");
	await writeFile(path, '{"backend":"git","multiplexer":"none"}\n', "utf8");
	assert.deepEqual(await loadConfig(path), { backend: "git", multiplexer: "none" });
});

test("config errors identify the external file", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-gibbon-config-errors-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "invalid.json");
	await writeFile(path, '{"backend":"herdr"}\n', "utf8");
	await assert.rejects(loadConfig(path), new RegExp(`Invalid pi-gibbon config ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

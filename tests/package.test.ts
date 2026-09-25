import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("package has one explicit Pi entrypoint and no conventional duplicate entrypoint", async () => {
	const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<string, any>;
	assert.equal(manifest.name, "pi-gibbon");
	assert.equal(manifest.private, undefined);
	assert.deepEqual(manifest.files, ["src", "pi-gibbon.example.json", "THIRD_PARTY_NOTICES.md"]);
	assert.equal(manifest.repository.url, "git+https://github.com/ludoroo/pi-gibbon.git");
	assert.deepEqual(manifest.publishConfig, { access: "public" });
	assert.deepEqual(manifest.pi, {
		extensions: ["./src/index.ts"],
		image: "https://raw.githubusercontent.com/ludoroo/pi-gibbon/main/media/logo.png",
	});
	assert.deepEqual(manifest.dependencies, undefined);
	assert.deepEqual(manifest.peerDependencies, {
		"@earendil-works/pi-ai": "*",
		"@earendil-works/pi-coding-agent": "*",
		typebox: "*",
	});
	await assert.rejects(access(join(root, "extensions")));
	await assert.rejects(access(join(root, "index.ts")));
	await assert.rejects(access(join(root, "pi-gibbon.json")));
	await access(join(root, "pi-gibbon.example.json"));
});

test("Pi's resource loader loads one extension with one tool and command", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-gibbon-agent-"));
	t.after(() => rm(agentDir, { recursive: true, force: true }));
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		additionalExtensionPaths: [join(root, "src", "index.ts")],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	assert.deepEqual([...loaded.extensions[0]!.tools.keys()], ["worktree_jump"]);
	assert.deepEqual([...loaded.extensions[0]!.commands.keys()], ["worktree-jump"]);
});

test("license and third-party notice preserve the upstream MIT attribution", async () => {
	const license = await readFile(join(root, "LICENSE"), "utf8");
	const notice = await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
	assert.match(license, /Copyright \(c\) 2025 Can Celik/);
	assert.match(notice, /ogulcancelik\/pi-extensions/);
	assert.match(notice, /Copyright \(c\) 2025 Can Celik/);
});

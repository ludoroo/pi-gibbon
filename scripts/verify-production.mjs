import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = await mkdtemp(join(tmpdir(), "pi-gibbon-production-"));
const agentDir = await mkdtemp(join(tmpdir(), "pi-gibbon-production-agent-"));

try {
	for (const path of [
		"package.json",
		"package-lock.json",
		"LICENSE",
		"THIRD_PARTY_NOTICES.md",
		"README.md",
		"pi-gibbon.example.json",
	]) {
		await cp(join(root, path), join(packageRoot, path));
	}
	await cp(join(root, "src"), join(packageRoot, "src"), { recursive: true });

	const install = spawnSync(
		"npm",
		["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
		{ cwd: packageRoot, encoding: "utf8", timeout: 120_000 },
	);
	assert.equal(install.status, 0, install.stderr || install.stdout);
	assert.equal(existsSync(join(packageRoot, "node_modules", "typescript")), false);
	assert.equal(existsSync(join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent")), false);
	assert.equal(existsSync(join(packageRoot, "node_modules", "typebox")), false);

	const piBinary = join(root, "node_modules", ".bin", "pi");
	const rpc = spawnSync(
		piBinary,
		[
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"-e",
			packageRoot,
		],
		{
			cwd: packageRoot,
			encoding: "utf8",
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			input: '{"type":"get_commands"}\n',
			timeout: 60_000,
			maxBuffer: 10 * 1024 * 1024,
		},
	);
	assert.equal(rpc.status, 0, rpc.stderr || rpc.stdout);
	assert.doesNotMatch(rpc.stderr, /Failed to load extension|Cannot find module/);

	const messages = rpc.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const response = messages.find((message) => message.type === "response" && message.command === "get_commands");
	assert.ok(response?.success, `No successful get_commands response in:\n${rpc.stdout}`);
	const matches = response.data.commands.filter((command) => command.name === "worktree-jump");
	assert.equal(matches.length, 1);
	assert.match(matches[0].sourceInfo.path, new RegExp(`^${escapeRegExp(packageRoot)}/src/index\\.ts$`));

	const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
	console.log("Production-style package install and isolated Pi load passed.");
} finally {
	await rm(packageRoot, { recursive: true, force: true });
	await rm(agentDir, { recursive: true, force: true });
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

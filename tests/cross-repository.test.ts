import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import piGibbon from "../src/index.ts";

type Tool = { execute: (...args: any[]) => Promise<any> };
type Command = { handler: (args: string, ctx: any) => Promise<void> };

async function setup(
	t: TestContext,
	multiplexer: "none" | "herdr" = "none",
	backend: "git" | "worktrunk" = "git",
) {
	const root = await mkdtemp(join(tmpdir(), "pi-gibbon-cross-repo-"));
	const source = join(root, "source");
	const target = join(root, "target");
	const linked = join(root, "target-linked");
	const agentDir = join(root, "agent");
	await Promise.all([mkdir(source), mkdir(target), mkdir(agentDir)]);
	for (const path of [source, target]) {
		git(path, "init", "-b", "main");
		git(path, "config", "user.email", "test@example.com");
		git(path, "config", "user.name", "Test");
		await writeFile(join(path, "README"), path);
		git(path, "add", "README");
		git(path, "commit", "-m", "initial");
	}
	git(target, "worktree", "add", "-b", "already-linked", linked);

	const envKeys = ["PI_CODING_AGENT_DIR", "PI_GIBBON_CONFIG", "HERDR_ENV", "HERDR_PANE_ID"] as const;
	const previous = envKeys.map((key) => process.env[key]);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_GIBBON_CONFIG = join(root, "config.json");
	await writeFile(process.env.PI_GIBBON_CONFIG, JSON.stringify({ backend, multiplexer }));
	if (multiplexer === "herdr") {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "w-source:p-old";
	} else {
		delete process.env.HERDR_ENV;
		delete process.env.HERDR_PANE_ID;
	}
	t.after(async () => {
		envKeys.forEach((key, index) => {
			const value = previous[index];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		});
		await rm(root, { recursive: true, force: true });
	});

	const sessionManager = SessionManager.create(source);
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "move to target" }],
		timestamp: Date.now(),
	} as any);
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "preparing" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as any);
	const tools = new Map<string, Tool>();
	const commands = new Map<string, Command>();
	let dispatched = "";
	const pi = {
		on() {},
		registerTool(tool: Tool & { name: string }) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: Command) { commands.set(name, command); },
		sendUserMessage(message: string) { dispatched = message; },
		async exec(command: string, args: string[], options: { cwd: string }) {
			const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
			return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1, killed: false };
		},
	};
	piGibbon(pi as any);
	const tool = tools.get("worktree_jump");
	assert.ok(tool);
	const ctx = {
		cwd: source,
		sessionManager,
		ui: { setStatus() {} },
	};
	return { linked, pi, source, target, tool, commands, ctx, dispatched: () => dispatched };
}

function git(cwd: string, ...args: string[]) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
}

function success(stdout = "") {
	return { stdout, stderr: "", code: 0, killed: false };
}

test("cross-repository new creates a real target worktree based on the target checkout HEAD", async (t) => {
	const fixture = await setup(t);
	const result = await fixture.tool.execute("call", {
		destination: "new",
		repository: fixture.target,
		branch: "cross/new",
	}, undefined, undefined, fixture.ctx);
	const targetPath = result.details.worktreePath as string;
	assert.equal(targetPath, join(await realpath(join(fixture.target, "..")), ".target-cross-new"));
	assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: targetPath, encoding: "utf8" }).stdout.trim(),
		spawnSync("git", ["rev-parse", "HEAD"], { cwd: fixture.target, encoding: "utf8" }).stdout.trim());
	assert.match(fixture.dispatched(), /^\/worktree-jump /);
});

test("native Git accepts a branch already checked out at the cross-repository target root", async (t) => {
	const fixture = await setup(t);
	const sourceSessionFile = fixture.ctx.sessionManager.getSessionFile();
	assert.ok(sourceSessionFile);
	const result = await fixture.tool.execute("call", {
		destination: "new", repository: fixture.target, branch: "main",
	}, undefined, undefined, fixture.ctx);
	assert.equal(result.details.worktreePath, await realpath(fixture.target));
	assert.equal(result.details.backend, "git");
	assert.match(fixture.dispatched(), /^\/worktree-jump /);
	await access(sourceSessionFile);
});

test("mocked Worktrunk accepts a branch already checked out at the cross-repository target root", async (t) => {
	const fixture = await setup(t, "none", "worktrunk");
	const sourceSessionFile = fixture.ctx.sessionManager.getSessionFile();
	assert.ok(sourceSessionFile);
	const calls: Array<{ args: string[]; cwd: string }> = [];
	fixture.pi.exec = async (command: string, args: string[], options: { cwd: string }) => {
		if (command === "sh") return success();
		if (command === "wt") {
			calls.push({ args, cwd: options.cwd });
			return success(JSON.stringify({ path: await realpath(fixture.target), branch: "main" }));
		}
		const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
		return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1, killed: false };
	};

	const result = await fixture.tool.execute("call", {
		destination: "new", repository: fixture.target, branch: "main",
	}, undefined, undefined, fixture.ctx);
	assert.equal(result.details.worktreePath, await realpath(fixture.target));
	assert.equal(result.details.backend, "worktrunk");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.cwd, await realpath(fixture.target));
	assert.deepEqual(calls[0]?.args.slice(0, 5), ["-C", await realpath(fixture.target), "switch", "main", "--no-cd"]);
	await access(sourceSessionFile);
	assert.match(fixture.dispatched(), /^\/worktree-jump /);
});

test("mocked Worktrunk uses -C and default --base @ from the named linked checkout", async (t) => {
	const fixture = await setup(t, "none", "worktrunk");
	await writeFile(join(fixture.linked, "linked-only"), "linked head\n");
	git(fixture.linked, "add", "linked-only");
	git(fixture.linked, "commit", "-m", "linked checkout head");
	const namedCheckout = await realpath(fixture.linked);
	const namedHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: namedCheckout, encoding: "utf8" }).stdout.trim();
	const primaryHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: fixture.target, encoding: "utf8" }).stdout.trim();
	assert.notEqual(namedHead, primaryHead);
	const branch = "from-worktrunk-linked";
	const worktreePath = join(await realpath(dirname(fixture.target)), ".worktrunk-linked-base");
	const calls: Array<{ args: string[]; cwd: string }> = [];
	fixture.pi.exec = async (command: string, args: string[], options: { cwd: string }) => {
		if (command === "sh") return success();
		if (command === "wt") {
			calls.push({ args, cwd: options.cwd });
			const created = spawnSync("git", ["worktree", "add", "-b", branch, worktreePath, "@"], {
				cwd: options.cwd,
				encoding: "utf8",
			});
			assert.equal(created.status, 0, created.stderr);
			return success(JSON.stringify({ path: worktreePath, branch }));
		}
		const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
		return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1, killed: false };
	};

	const result = await fixture.tool.execute("call", {
		destination: "new", repository: fixture.linked, branch,
	}, undefined, undefined, fixture.ctx);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.cwd, namedCheckout);
	assert.deepEqual(calls[0]?.args.slice(0, 7), ["-C", namedCheckout, "switch", "--create", "--base", "@", branch]);
	assert.ok(calls[0]?.args.includes("--no-cd"));
	assert.ok(calls[0]?.args.includes("--format=json"));
	const createdHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).stdout.trim();
	assert.equal(createdHead, namedHead);
	assert.equal(result.details.worktreePath, await realpath(worktreePath));
});

for (const base of [undefined, "HEAD", "HEAD~1"]) {
	test(`new worktree resolves ${base ?? "the default base"} in the named linked checkout`, async (t) => {
		const fixture = await setup(t);
		await writeFile(join(fixture.linked, "linked-only"), "linked head\n");
		git(fixture.linked, "add", "linked-only");
		git(fixture.linked, "commit", "-m", "linked checkout head");
		const namedHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: fixture.linked, encoding: "utf8" }).stdout.trim();
		const primaryHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: fixture.target, encoding: "utf8" }).stdout.trim();
		assert.notEqual(namedHead, primaryHead);

		const result = await fixture.tool.execute("call", {
			destination: "new", repository: fixture.linked, branch: "from-linked-head", base,
		}, undefined, undefined, fixture.ctx);
		const createdHead = spawnSync("git", ["rev-parse", "HEAD"], {
			cwd: result.details.worktreePath,
			encoding: "utf8",
		}).stdout.trim();
		const expectedHead = spawnSync("git", ["rev-parse", base ?? "HEAD"], {
			cwd: fixture.linked, encoding: "utf8",
		}).stdout.trim();
		assert.equal(createdHead, expectedHead);
	});
}

test("existing relocates to the exact specified linked checkout without switching its branch", async (t) => {
	const fixture = await setup(t);
	const result = await fixture.tool.execute("call", {
		destination: "existing",
		repository: fixture.linked,
		label: "Target project",
	}, undefined, undefined, fixture.ctx);
	assert.equal(result.details.worktreePath, await realpath(fixture.linked));
	assert.equal(result.details.branch, "already-linked");
	assert.equal(result.details.backend, "existing-main");
});

test("existing requires a repository and rejects branch and base", async (t) => {
	const fixture = await setup(t);
	await assert.rejects(fixture.tool.execute("call", {
		destination: "existing",
	}, undefined, undefined, fixture.ctx), /repository is required/);
	await assert.rejects(fixture.tool.execute("call", {
		destination: "existing", repository: fixture.target, branch: "feature",
	}, undefined, undefined, fixture.ctx), /branch and base apply only when destination is new/);
	await assert.rejects(fixture.tool.execute("call", {
		destination: "existing", repository: fixture.target, base: "main",
	}, undefined, undefined, fixture.ctx), /branch and base apply only when destination is new/);
});

test("main targets another repository's primary checkout but rejects the source checkout", async (t) => {
	const fixture = await setup(t);
	const result = await fixture.tool.execute("call", {
		destination: "main", repository: "../target",
	}, undefined, undefined, fixture.ctx);
	assert.equal(result.details.worktreePath, await realpath(fixture.target));
	assert.equal(result.details.backend, "existing-main");

	const sourceFixture = await setup(t);
	await assert.rejects(sourceFixture.tool.execute("call", {
		destination: "main", repository: sourceFixture.source,
	}, undefined, undefined, sourceFixture.ctx), /already inside the requested checkout/);
});

test("repository paths expand ~/ against the current home directory", async (t) => {
	const fixture = await setup(t);
	const previousHome = process.env.HOME;
	process.env.HOME = await realpath(join(fixture.target, ".."));
	try {
		const result = await fixture.tool.execute("call", {
			destination: "existing", repository: "~/target",
		}, undefined, undefined, fixture.ctx);
		assert.equal(result.details.worktreePath, await realpath(fixture.target));
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
	}
});

test("repository paths must name checkout roots, not subdirectories", async (t) => {
	const fixture = await setup(t);
	await mkdir(join(fixture.target, "subdir"));
	await assert.rejects(fixture.tool.execute("call", {
		destination: "new", repository: join(fixture.target, "subdir"), branch: "feature",
	}, undefined, undefined, fixture.ctx), /repository path must be a checkout root/);
});

test("invalid repositories and same-source symlinks fail without dispatching or removing the source session", async (t) => {
	const fixture = await setup(t);
	const sourceSessionFile = fixture.ctx.sessionManager.getSessionFile();
	assert.ok(sourceSessionFile);
	const parent = await realpath(dirname(fixture.source));
	const nonGit = join(parent, "not-a-repository");
	const bare = join(parent, "bare.git");
	await mkdir(nonGit);
	await mkdir(bare);
	git(bare, "init", "--bare");

	await assert.rejects(fixture.tool.execute("call", {
		destination: "new", repository: join(parent, "missing"), branch: "missing-repo",
	}, undefined, undefined, fixture.ctx), /Directory does not exist/);
	await assert.rejects(fixture.tool.execute("call", {
		destination: "new", repository: nonGit, branch: "non-git-repo",
	}, undefined, undefined, fixture.ctx), /not a git repository/i);
	await assert.rejects(fixture.tool.execute("call", {
		destination: "new", repository: bare, branch: "bare-repo",
	}, undefined, undefined, fixture.ctx), /not a git repository|must be run in a work tree/i);

	const sourceAlias = join(parent, "source-symlink");
	await symlink(fixture.source, sourceAlias);
	await assert.rejects(fixture.tool.execute("call", {
		destination: "new", repository: sourceAlias, branch: "main",
	}, undefined, undefined, fixture.ctx), /already inside the requested checkout/);
	assert.equal(fixture.dispatched(), "");
	await access(sourceSessionFile);
});

test("cross-repository in-process relocation forks the session into the selected checkout", async (t) => {
	const fixture = await setup(t);
	const oldSessionFile = fixture.ctx.sessionManager.getSessionFile();
	assert.ok(oldSessionFile);
	const result = await fixture.tool.execute("call", {
		destination: "main", repository: fixture.target,
	}, undefined, undefined, fixture.ctx);
	const command = fixture.commands.get("worktree-jump");
	assert.ok(command);
	let forkedFile = "";
	await command.handler(fixture.dispatched().slice("/worktree-jump ".length), {
		waitForIdle: async () => undefined,
		ui: { setStatus() {}, notify() {} },
		async switchSession(path: string, options: { withSession: (ctx: any) => Promise<void> }) {
			forkedFile = path;
			await options.withSession({ ui: { setStatus() {}, notify() {} }, async sendUserMessage() {} });
			return { cancelled: false };
		},
	});
	assert.ok(forkedFile);
	const header = JSON.parse((await readFile(forkedFile, "utf8")).split("\n")[0]!) as { cwd: string };
	assert.equal(header.cwd, await realpath(fixture.target));
	await assert.rejects(access(oldSessionFile));
	assert.equal(result.details.worktreePath, header.cwd);
});

test("cross-repository Herdr opens in the target repository and checks focus in the source", async (t) => {
	const fixture = await setup(t, "herdr");
	const calls: Array<{ args: string[]; cwd: string }> = [];
	fixture.pi.exec = async (program: string, args: string[], options: { cwd: string }) => {
		if (program === "git") {
			const result = spawnSync(program, args, { cwd: options.cwd, encoding: "utf8" });
			return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1, killed: false };
		}
		if (program === "sh") return success();
		if (program !== "herdr") throw new Error(`Unexpected command: ${program}`);
		calls.push({ args, cwd: options.cwd });
		if (args[0] === "worktree" && args[1] === "open") {
			return success(JSON.stringify({ result: {
				workspace: { workspace_id: "w-target" },
				tab: { tab_id: "w-target:t1" },
				root_pane: { pane_id: "w-target:p1" },
				already_open: false,
			} }));
		}
		if (args[0] === "pane" && args[1] === "run") {
			const readyFile = args[3]?.match(/PI_GIBBON_READY_FILE=([^']+)/)?.[1];
			assert.ok(readyFile);
			await writeFile(readyFile, "ready\n");
			return success();
		}
		if (args[0] === "pane" && args[1] === "current") {
			return success(JSON.stringify({ result: { pane: { workspace_id: "w-source" } } }));
		}
		if (args[0] === "workspace" && args[1] === "get") {
			return success(JSON.stringify({ result: { workspace: { workspace_id: "w-source", focused: true } } }));
		}
		return success();
	};

	await fixture.tool.execute("call", {
		destination: "main", repository: fixture.target,
	}, undefined, undefined, fixture.ctx);
	const command = fixture.commands.get("worktree-jump");
	assert.ok(command);
	await command.handler(fixture.dispatched().slice("/worktree-jump ".length), {
		signal: undefined,
		waitForIdle: async () => undefined,
		ui: { setStatus() {}, notify() {} },
		shutdown() {},
	});
	const targetMain = await realpath(fixture.target);
	const sourceMain = await realpath(fixture.source);
	const open = calls.find((call) => call.args[0] === "worktree" && call.args[1] === "open");
	assert.ok(open);
	assert.equal(open.cwd, targetMain);
	assert.deepEqual(open.args.slice(0, 5), ["worktree", "open", "--cwd", targetMain, "--path"]);
	assert.ok(open.args.includes(targetMain));
	const sourceFocusCheck = calls.find((call) => call.args[0] === "pane" && call.args[1] === "current");
	assert.ok(sourceFocusCheck);
	assert.equal(sourceFocusCheck.cwd, sourceMain);
});

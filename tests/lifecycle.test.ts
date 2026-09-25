import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import piGibbon from "../src/index.ts";

type Tool = {
	execute: (...args: any[]) => Promise<any>;
};

type Command = {
	handler: (args: string, ctx: any) => Promise<void>;
};

type HerdrBehavior = {
	focusLookupFails?: boolean;
	launchSucceeds?: boolean;
	sourceWorkspaceFocused?: boolean;
	targetHasTab?: boolean;
};

async function prepareMainJump(
	t: TestContext,
	signal?: AbortSignal,
	multiplexer: "none" | "herdr" = "none",
	herdrBehavior: HerdrBehavior = {},
) {
	const root = await mkdtemp(join(tmpdir(), "pi-gibbon-lifecycle-"));
	const mainCheckout = join(root, "main");
	const linkedCheckout = join(root, "linked");
	const agentDir = join(root, "agent");
	await Promise.all([
		mkdir(mainCheckout, { recursive: true }),
		mkdir(linkedCheckout, { recursive: true }),
		mkdir(agentDir, { recursive: true }),
	]);
	await writeFile(
		join(agentDir, "pi-gibbon.json"),
		`${JSON.stringify({ backend: "auto", multiplexer })}\n`,
		"utf8",
	);

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousConfig = process.env.PI_GIBBON_CONFIG;
	const previousHerdrEnv = process.env.HERDR_ENV;
	const previousHerdrPane = process.env.HERDR_PANE_ID;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_GIBBON_CONFIG;
	if (multiplexer === "herdr") {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "w-original:p-source";
	}
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousConfig === undefined) delete process.env.PI_GIBBON_CONFIG;
		else process.env.PI_GIBBON_CONFIG = previousConfig;
		if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdrEnv;
		if (previousHerdrPane === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = previousHerdrPane;
		await rm(root, { recursive: true, force: true });
	});

	const sessionManager = SessionManager.create(linkedCheckout);
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "move to main" }],
		timestamp: Date.now(),
	} as any);
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "preparing" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as any);
	const oldSessionFile = sessionManager.getSessionFile();
	assert.ok(oldSessionFile);
	await access(oldSessionFile);

	const tools = new Map<string, Tool>();
	const commands = new Map<string, Command>();
	const herdrCalls: string[][] = [];
	const shellCalls: string[][] = [];
	let dispatched = "";
	const pi = {
		on() {},
		registerTool(tool: Tool & { name: string }) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
		sendUserMessage(message: string) {
			dispatched = message;
		},
		async exec(command: string, args: string[]) {
			if (command === "sh" && multiplexer === "herdr") {
				shellCalls.push(args);
				return success();
			}
			if (command === "herdr" && multiplexer === "herdr") {
				herdrCalls.push(args);
				if (args[0] === "worktree" && args[1] === "open") {
					return success(JSON.stringify({
						id: "test",
						result: {
							workspace: { workspace_id: "w-target" },
							...(herdrBehavior.targetHasTab === false ? {} : { tab: { tab_id: "w-target:t1" } }),
							root_pane: { pane_id: "w-target:p1" },
							worktree: { path: mainCheckout, branch: "main" },
							already_open: false,
						},
					}));
				}
				if (args[0] === "pane" && args[1] === "run") {
					if (!herdrBehavior.launchSucceeds) {
						return { stdout: "", stderr: "replacement launch failed", code: 1, killed: false };
					}
					const readyFile = args[3]?.match(/PI_GIBBON_READY_FILE=([^']+)/)?.[1];
					assert.ok(readyFile, "replacement command must include its readiness file");
					await writeFile(readyFile, "replacement-ready\n", "utf8");
					return success();
				}
				if (args[0] === "pane" && args[1] === "current") {
					assert.deepEqual(args, ["pane", "current", "--current"]);
					return success(JSON.stringify({
						id: "test",
						result: {
							type: "pane_current",
							pane: { workspace_id: "w-live-source" },
						},
					}));
				}
				if (args[0] === "workspace" && args[1] === "get") {
					if (herdrBehavior.focusLookupFails) {
						return { stdout: "", stderr: "source workspace disappeared", code: 1, killed: false };
					}
					return success(JSON.stringify({
						id: "test",
						result: {
							type: "workspace_info",
							workspace: {
								workspace_id: "w-live-source",
								focused: herdrBehavior.sourceWorkspaceFocused ?? true,
							},
						},
					}));
				}
				if (args[0] === "workspace" && args[1] === "focus") return success();
				if (args[0] === "tab" && args[1] === "focus") return success();
				if (args[0] === "pane" && args[1] === "close") return success();
				throw new Error(`Unexpected Herdr command: ${args.join(" ")}`);
			}
			if (command !== "git") throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return success(`${linkedCheckout}\n`);
			if (args[0] === "worktree" && args[1] === "list") {
				return success(
					`worktree ${mainCheckout}\0HEAD aaaa\0branch refs/heads/main\0\0` +
						`worktree ${linkedCheckout}\0HEAD bbbb\0branch refs/heads/feature\0\0`,
				);
			}
			if (args[0] === "branch" && args[1] === "--show-current") return success("main\n");
			throw new Error(`Unexpected git command: ${args.join(" ")}`);
		},
	};
	piGibbon(pi as any);

	const statuses: Array<string | undefined> = [];
	const tool = tools.get("worktree_jump");
	assert.ok(tool);
	const result = await tool.execute(
		"call",
		{ destination: "main" },
		signal,
		undefined,
		{
			cwd: linkedCheckout,
			sessionManager,
			ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
		},
	);
	assert.equal(result.terminate, true);
	assert.match(dispatched, /^\/worktree-jump /);
	const token = dispatched.slice("/worktree-jump ".length);
	assert.ok(token);
	const command = commands.get("worktree-jump");
	assert.ok(command);

	return { command, herdrCalls, mainCheckout, oldSessionFile, shellCalls, statuses, token };
}

function success(stdout = "") {
	return { stdout, stderr: "", code: 0, killed: false };
}

function commandUi(statuses: Array<string | undefined>, notifications: string[]) {
	return {
		setStatus(_key: string, value: string | undefined) {
			statuses.push(value);
		},
		notify(message: string) {
			notifications.push(message);
		},
	};
}

test("finalization waits for idle, forks complete history, and uses the replacement context", async (t) => {
	const prepared = await prepareMainJump(t);
	let idleReleased = false;
	let releaseIdle: (() => void) | undefined;
	const idle = new Promise<void>((resolve) => {
		releaseIdle = () => {
			idleReleased = true;
			resolve();
		};
	});
	let switchCalls = 0;
	let newSessionFile = "";
	const sourceNotifications: string[] = [];
	const replacementNotifications: string[] = [];
	const continuationMessages: string[] = [];

	const handling = prepared.command.handler(prepared.token, {
		waitForIdle: () => idle,
		ui: commandUi(prepared.statuses, sourceNotifications),
		async switchSession(path: string, options: { withSession: (ctx: any) => Promise<void> }) {
			assert.ok(idleReleased, "session fork and switch must happen only after waitForIdle resolves");
			switchCalls += 1;
			newSessionFile = path;
			await options.withSession({
				ui: commandUi(prepared.statuses, replacementNotifications),
				async sendUserMessage(message: string) { continuationMessages.push(message); },
			});
			return { cancelled: false };
		},
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(switchCalls, 0, "session fork and switch must wait until the tool turn is idle");
	assert.deepEqual(await SessionManager.list(await realpath(prepared.mainCheckout)), []);

	releaseIdle?.();
	await handling;
	assert.equal(switchCalls, 1);
	const entries = (await readFile(newSessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	const canonicalTarget = entries[0].cwd as string;
	assert.equal(canonicalTarget, await realpath(prepared.mainCheckout));
	assert.equal(entries[0].parentSession, undefined);
	assert.deepEqual(entries.slice(1).map((entry) => entry.message.role), ["user", "assistant"]);
	await assert.rejects(access(prepared.oldSessionFile));
	assert.deepEqual(sourceNotifications, []);
	assert.ok(replacementNotifications.some((message) => message.includes(`Moved Pi session to ${canonicalTarget}`)));
	assert.deepEqual(continuationMessages, [`Moved to worktree ${canonicalTarget}. Continue.`]);
});

test("an aborted pending jump waits for idle but never forks or switches", async (t) => {
	const controller = new AbortController();
	const prepared = await prepareMainJump(t, controller.signal);
	controller.abort();
	let switchCalls = 0;
	const notifications: string[] = [];
	await prepared.command.handler(prepared.token, {
		waitForIdle: async () => undefined,
		ui: commandUi(prepared.statuses, notifications),
		async switchSession() { switchCalls += 1; return { cancelled: false }; },
	});
	assert.equal(switchCalls, 0);
	await access(prepared.oldSessionFile);
	assert.ok(notifications.some((message) => message.includes("cancelled")));
});

test("a cancelled in-process switch removes the unused fork and retains the source", async (t) => {
	const prepared = await prepareMainJump(t);
	let forkedFile = "";
	const notifications: string[] = [];
	await prepared.command.handler(prepared.token, {
		waitForIdle: async () => undefined,
		ui: commandUi(prepared.statuses, notifications),
		async switchSession(path: string) { forkedFile = path; return { cancelled: true }; },
	});
	assert.ok(forkedFile);
	await assert.rejects(access(forkedFile));
	await access(prepared.oldSessionFile);
	assert.ok(notifications.some((message) => message.includes("cancelled")));
});

test("a failed in-process switch removes the orphaned fork and clears source status", async (t) => {
	const prepared = await prepareMainJump(t);
	let forkedFile = "";
	const failure = new Error("switch failed before activation");
	await assert.rejects(
		prepared.command.handler(prepared.token, {
			waitForIdle: async () => undefined,
			ui: commandUi(prepared.statuses, []),
			async switchSession(path: string) { forkedFile = path; throw failure; },
		}),
		failure,
	);
	assert.ok(forkedFile);
	await assert.rejects(access(forkedFile));
	await access(prepared.oldSessionFile);
	assert.equal(prepared.statuses.at(-1), undefined);
});

for (const scenario of [
	{ sourceWorkspaceFocused: true, expectedDestinationFocus: true, label: "focused" },
	{ sourceWorkspaceFocused: false, expectedDestinationFocus: false, label: "not focused" },
]) {
	test(`a ready Herdr replacement only takes focus when the source workspace is ${scenario.label}`, async (t) => {
		const prepared = await prepareMainJump(t, undefined, "herdr", {
			launchSucceeds: true,
			sourceWorkspaceFocused: scenario.sourceWorkspaceFocused,
		});
		let shutdownCalls = 0;
		await prepared.command.handler(prepared.token, {
			signal: undefined,
			waitForIdle: async () => undefined,
			ui: commandUi(prepared.statuses, []),
			shutdown() { shutdownCalls += 1; },
		});

		const openCall = prepared.herdrCalls.find((args) => args[0] === "worktree" && args[1] === "open");
		assert.ok(openCall);
		assert.ok(openCall.includes("--no-focus"));
		assert.equal(openCall.includes("--focus"), false);
		const runIndex = prepared.herdrCalls.findIndex((args) => args[0] === "pane" && args[1] === "run");
		const currentPaneIndex = prepared.herdrCalls.findIndex((args) => args[0] === "pane" && args[1] === "current");
		const sourceFocusIndex = prepared.herdrCalls.findIndex(
			(args) => args[0] === "workspace" && args[1] === "get" && args[2] === "w-live-source",
		);
		const targetWorkspaceFocusIndex = prepared.herdrCalls.findIndex(
			(args) => args[0] === "workspace" && args[1] === "focus" && args[2] === "w-target",
		);
		const targetTabFocusIndex = prepared.herdrCalls.findIndex(
			(args) => args[0] === "tab" && args[1] === "focus" && args[2] === "w-target:t1",
		);
		assert.ok(runIndex < currentPaneIndex && currentPaneIndex < sourceFocusIndex);
		if (scenario.expectedDestinationFocus) {
			assert.ok(sourceFocusIndex < targetWorkspaceFocusIndex);
			assert.ok(targetWorkspaceFocusIndex < targetTabFocusIndex);
		} else {
			assert.equal(targetWorkspaceFocusIndex, -1);
			assert.equal(targetTabFocusIndex, -1);
		}
		assert.equal(shutdownCalls, 1);
	});
}

test("Herdr focuses the destination workspace when an opened worktree has no tab id", async (t) => {
	const prepared = await prepareMainJump(t, undefined, "herdr", {
		launchSucceeds: true,
		targetHasTab: false,
	});
	await prepared.command.handler(prepared.token, {
		signal: undefined,
		waitForIdle: async () => undefined,
		ui: commandUi(prepared.statuses, []),
		shutdown() {},
	});
	assert.ok(prepared.herdrCalls.some(
		(args) => args[0] === "workspace" && args[1] === "focus" && args[2] === "w-target",
	));
	assert.equal(prepared.herdrCalls.some((args) => args[0] === "tab" && args[1] === "focus"), false);
});

test("a failed Herdr focus check leaves the destination in the background and still finishes cleanup", async (t) => {
	const prepared = await prepareMainJump(t, undefined, "herdr", {
		focusLookupFails: true,
		launchSucceeds: true,
	});
	const notifications: string[] = [];
	let shutdownCalls = 0;
	await prepared.command.handler(prepared.token, {
		signal: undefined,
		waitForIdle: async () => undefined,
		ui: commandUi(prepared.statuses, notifications),
		shutdown() { shutdownCalls += 1; },
	});
	assert.equal(prepared.herdrCalls.some(
		(args) => (args[0] === "workspace" || args[0] === "tab") && args[1] === "focus",
	), false);
	assert.ok(notifications.some((message) => message.includes("left in the background")));
	assert.ok(prepared.shellCalls.some((args) => args[1]?.includes("old_pid=")));
	assert.equal(shutdownCalls, 1);
});

test("a failed Herdr launch closes its replacement pane, removes the fork, and preserves the source", async (t) => {
	const prepared = await prepareMainJump(t, undefined, "herdr");
	await assert.rejects(
		prepared.command.handler(prepared.token, {
			signal: undefined,
			waitForIdle: async () => undefined,
			ui: commandUi(prepared.statuses, []),
			shutdown() { assert.fail("source must remain active when replacement launch fails"); },
		}),
		/replacement pane was closed and the old session remains active/,
	);
	assert.ok(prepared.herdrCalls.some((args) => args[0] === "pane" && args[1] === "run"));
	assert.ok(prepared.herdrCalls.some((args) => args[0] === "pane" && args[1] === "close" && args[2] === "w-target:p1"));
	assert.deepEqual(await SessionManager.list(await realpath(prepared.mainCheckout)), []);
	await access(prepared.oldSessionFile);
	assert.equal(prepared.statuses.at(-1), undefined);
});

/**
 * Configurable Pi session relocation across Git worktrees.
 * Adapted from @ogulcancelik/pi-herdr-worktree-jump v0.1.0 (MIT).
 * Original: https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-herdr-worktree-jump
 */
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import {
	consumePending,
	dispatchPending,
	parseGitWorktrees,
	planGitWorktreePath,
	resolveBackend,
	resolveMultiplexer,
	type ResolvedBackendName,
	type ResolvedMultiplexerName,
	type PiGibbonConfig,
} from "./core.ts";
import { buildOldPaneCleanupLauncher, shellQuote } from "./cleanup.ts";
import { loadConfig } from "./config.ts";

type JumpDestination = "new" | "main";

type JumpOptions = {
	destination: JumpDestination;
	branch?: string;
	base?: string;
	label?: string;
};

type Repository = {
	currentCheckout: string;
	mainCheckout: string;
};

type WorktreeTarget = {
	worktreePath: string;
	branch?: string;
};

type PendingJump = {
	backend: ResolvedBackendName | "existing-main";
	multiplexer: ResolvedMultiplexerName;
	destination: JumpDestination;
	target: WorktreeTarget;
	repository: Repository;
	label?: string;
	oldSessionFile: string;
	signal?: AbortSignal;
};

type HerdrEnvelope<T> = {
	result?: T;
	error?: { code?: string; message?: string };
};

type WorktreeOpened = {
	workspace?: { workspace_id?: string };
	tab?: { tab_id?: string };
	root_pane?: { pane_id?: string };
	worktree?: { path?: string; branch?: string };
	already_open?: boolean;
};

type TabCreated = {
	tab?: { tab_id?: string };
	root_pane?: { pane_id?: string };
};

type PaneCurrent = {
	pane?: { workspace_id?: string };
};

type WorkspaceInfo = {
	workspace?: { workspace_id?: string; focused?: boolean };
};

type WorktrunkSwitched = {
	path?: string;
	branch?: string;
};

type WorktreeBackendAdapter = {
	create: (
		pi: ExtensionAPI,
		signal: AbortSignal | undefined,
		repository: Repository,
		currentDirectory: string,
		options: JumpOptions,
	) => Promise<WorktreeTarget>;
};

type MultiplexerAdapter = {
	validate?: () => void;
	relocate: (
		pi: ExtensionAPI,
		ctx: ExtensionCommandContext,
		jump: PendingJump,
		newSessionFile: string,
	) => Promise<void>;
};

const FINALIZE_COMMAND = "worktree-jump";
const STATUS_KEY = "pi-gibbon";

const BACKEND_ADAPTERS: Record<ResolvedBackendName, WorktreeBackendAdapter> = {
	worktrunk: { create: createWorktrunkWorktree },
	git: { create: createGitWorktree },
};

const MULTIPLEXER_ADAPTERS: Record<ResolvedMultiplexerName, MultiplexerAdapter> = {
	herdr: { relocate: relocateWithHerdr },
	none: { relocate: relocateWithoutMultiplexer },
	tmux: {
		validate() {
			throw new Error('Multiplexer "tmux" is reserved by the adapter contract but is not implemented yet');
		},
		async relocate() {
			throw new Error('Multiplexer "tmux" is not implemented yet');
		},
	},
};

export default function (pi: ExtensionAPI) {
	const pending = new Map<string, PendingJump>();
	let jumpInFlight = false;
	let readyFile = process.env.PI_GIBBON_READY_FILE;
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (readyFile) {
			await writeFile(readyFile, `${process.pid}\n`, "utf8");
			readyFile = undefined;
			delete process.env.PI_GIBBON_READY_FILE;
		}
	});

	pi.registerCommand(FINALIZE_COMMAND, {
		description: "Finalize a relocation prepared by the worktree_jump tool",
		handler: async (args, ctx) => {
			const token = args.trim();
			const ownsJump = pending.has(token);
			try {
				const outcome = await consumePending(
					pending,
					token,
					() => ctx.waitForIdle(),
					(jump) => !jump.signal?.aborted,
					(jump) => finalizeJump(pi, ctx, jump),
				);
				if (outcome === "missing") {
					ctx.ui.notify("No pending worktree jump matches that token", "error");
				} else if (outcome === "cancelled") {
					ctx.ui.notify("Worktree relocation cancelled; the checkout was retained", "warning");
				}
			} finally {
				if (ownsJump) jumpInFlight = false;
			}
		},
	});

	pi.registerTool({
		name: "worktree_jump",
		label: "pi-gibbon · Worktree Jump",
		description:
			"Relocate this Pi session to a linked Git worktree or back to the repository's main checkout. Pi-gibbon automatically uses the configured worktree and terminal integrations. This is an explicit session relocation, not a general isolation or worktree-planning tool.",
		promptSnippet: "Jump this Pi session to another worktree only when explicitly requested",
		promptGuidelines: [
			"Use worktree_jump only when the user explicitly asks to jump or move this Pi session into a new worktree or back to the repository's main checkout.",
			"Never use worktree_jump merely because isolation would be useful, repository instructions recommend a worktree, or the task appears non-trivial.",
		],
		parameters: Type.Object({
			destination: Type.Optional(
				StringEnum(["new", "main"] as const, {
					description: "Use new to create/open a worktree, or main to return to the primary checkout. Defaults to new.",
				}),
			),
			branch: Type.Optional(
				Type.String({ description: "Branch name for destination=new. Required when creating or opening a worktree." }),
			),
			base: Type.Optional(
				Type.String({
					description: "Git ref used as the base when destination=new creates a branch. Defaults to the current checkout's HEAD.",
				}),
			),
			label: Type.Optional(Type.String({ description: "Optional destination workspace label when supported." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (jumpInFlight) throw new Error("A worktree relocation is already pending");
			jumpInFlight = true;
			const options: JumpOptions = {
				destination: params.destination ?? "new",
				branch: cleanOptional(params.branch),
				base: cleanOptional(params.base),
				label: cleanOptional(params.label),
			};
			try {
				const config = await loadConfig();
				return await prepareJump(pi, ctx, signal, config, pending, options);
			} catch (error) {
				jumpInFlight = false;
				throw error;
			}
		},
	});
}

async function prepareJump(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	config: PiGibbonConfig,
	pending: Map<string, PendingJump>,
	options: JumpOptions,
) {
	const currentFile = ctx.sessionManager.getSessionFile();
	if (!currentFile) throw new Error("Current Pi session is not persisted, so it cannot jump to a worktree");
	if (options.destination === "main" && (options.branch || options.base || options.label)) {
		throw new Error("branch, base, and label apply only when destination is new");
	}

	const selectedMultiplexer = config.multiplexer;
	const shouldProbeHerdr = selectedMultiplexer === "auto" || selectedMultiplexer === "herdr";
	const herdrAvailable =
		shouldProbeHerdr &&
		process.env.HERDR_ENV === "1" &&
		Boolean(process.env.HERDR_PANE_ID) &&
		(await executableExists(pi, "herdr", signal, ctx.cwd));
	let backend: ResolvedBackendName | undefined;
	if (options.destination === "new") {
		const selectedBackend = config.backend;
		const worktrunkAvailable =
			selectedBackend !== "git" && (await executableExists(pi, "wt", signal, ctx.cwd));
		backend = resolveBackend(config.backend, worktrunkAvailable);
	}
	const multiplexer = resolveMultiplexer(config.multiplexer, herdrAvailable);
	MULTIPLEXER_ADAPTERS[multiplexer].validate?.();

	ctx.ui.setStatus(STATUS_KEY, "resolving repository");
	try {
		const repository = await resolveRepository(pi, signal, ctx.cwd);
		let target: WorktreeTarget;
		let usedBackend: ResolvedBackendName | "existing-main";
		if (options.destination === "main") {
			if (repository.currentCheckout === repository.mainCheckout) {
				throw new Error(`Pi is already inside the main checkout: ${repository.mainCheckout}`);
			}
			target = { worktreePath: repository.mainCheckout, branch: await currentBranch(pi, signal, repository.mainCheckout) };
			usedBackend = "existing-main";
		} else {
			if (!options.branch) throw new Error("branch is required when creating or opening a worktree");
			if (!backend) throw new Error("Worktree backend was not resolved");
			ctx.ui.setStatus(STATUS_KEY, `creating worktree with ${backend}`);
			target = await BACKEND_ADAPTERS[backend].create(pi, signal, repository, ctx.cwd, options);
			usedBackend = backend;
		}

		const canonicalTarget: WorktreeTarget = {
			...target,
			worktreePath: await canonicalDirectory(target.worktreePath),
		};
		const token = randomUUID();
		const prepared: PendingJump = {
			backend: usedBackend,
			multiplexer,
			destination: options.destination,
			target: canonicalTarget,
			repository,
			label: options.label,
			oldSessionFile: currentFile,
			signal,
		};
		try {
			dispatchPending(pending, token, prepared, () => {
				pi.sendUserMessage(`/${FINALIZE_COMMAND} ${token}`, {
					expandPromptTemplates: true,
				});
			});
		} catch (error) {
			throw new Error(`${errorMessage(error)}. The checkout was retained at ${canonicalTarget.worktreePath}`);
		}
		ctx.ui.setStatus(STATUS_KEY, undefined);

		return {
			content: [
				{
					type: "text" as const,
					text:
						`Prepared worktree relocation to ${canonicalTarget.worktreePath}.\n` +
						`Backend: ${usedBackend}\nMultiplexer: ${multiplexer}\n\n` +
						"The relocation is queued and will run after this tool turn settles.",
				},
			],
			details: {
				destination: options.destination,
				worktreePath: canonicalTarget.worktreePath,
				branch: canonicalTarget.branch,
				backend: usedBackend,
				multiplexer,
			},
			terminate: true,
		};
	} catch (error) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		throw error;
	}
}

async function finalizeJump(pi: ExtensionAPI, ctx: ExtensionCommandContext, jump: PendingJump): Promise<void> {
	ctx.ui.setStatus(STATUS_KEY, `relocating with ${jump.multiplexer}`);
	let newSessionFile: string;
	try {
		newSessionFile = await forkSessionFile(jump.oldSessionFile, jump.target.worktreePath);
	} catch (error) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		throw error;
	}
	// The adapter owns all cleanup from here. In-process switching can invalidate
	// this command context before it throws, so the caller must not touch ctx or
	// either session file after relocate() begins.
	await MULTIPLEXER_ADAPTERS[jump.multiplexer].relocate(pi, ctx, jump, newSessionFile);
}

async function resolveRepository(
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	cwd: string,
): Promise<Repository> {
	const currentResult = await git(pi, ["rev-parse", "--show-toplevel"], signal, cwd, 10_000);
	const currentCheckout = await canonicalDirectory(currentResult.stdout.trim());
	const listResult = await git(pi, ["worktree", "list", "--porcelain", "-z"], signal, currentCheckout, 10_000);
	const worktrees = parseGitWorktrees(listResult.stdout);
	const primary = worktrees[0];
	if (!primary || primary.bare) throw new Error("Git did not report a primary non-bare worktree");
	return {
		currentCheckout,
		mainCheckout: await canonicalDirectory(primary.path),
	};
}

async function createWorktrunkWorktree(
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	repository: Repository,
	currentDirectory: string,
	options: JumpOptions,
): Promise<WorktreeTarget> {
	const branch = options.branch!;
	await validateBranch(pi, signal, repository.mainCheckout, branch);
	const branchExists = await localBranchExists(pi, signal, repository.mainCheckout, branch);
	const args = ["-C", currentDirectory, "switch"];
	if (!branchExists) args.push("--create", "--base", options.base ?? "@");
	else if (options.base) throw new Error("base cannot be used when the Worktrunk branch already exists");
	args.push(branch, "--no-cd", "--format=json");

	const switched = await worktrunkJson<WorktrunkSwitched>(pi, args, signal, currentDirectory, 120_000);
	if (!switched.path) throw new Error("Worktrunk switch response did not include path");
	const worktreePath = await canonicalDirectory(switched.path);
	if (worktreePath === repository.currentCheckout) throw new Error(`Pi is already inside worktree: ${worktreePath}`);
	return { worktreePath, branch: switched.branch ?? branch };
}

async function createGitWorktree(
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	repository: Repository,
	currentDirectory: string,
	options: JumpOptions,
): Promise<WorktreeTarget> {
	const branch = options.branch!;
	await validateBranch(pi, signal, repository.mainCheckout, branch);
	const branchExists = await localBranchExists(pi, signal, repository.mainCheckout, branch);
	const listResult = await git(
		pi,
		["worktree", "list", "--porcelain", "-z"],
		signal,
		repository.mainCheckout,
		10_000,
	);
	const existing = parseGitWorktrees(listResult.stdout).find((worktree) => worktree.branch === branch);
	if (existing) {
		const existingPath = await canonicalDirectory(existing.path);
		if (existingPath === repository.currentCheckout) throw new Error(`Pi is already inside worktree: ${existingPath}`);
		if (options.base) throw new Error("base cannot be used when the Git branch is already checked out");
		return { worktreePath: existingPath, branch };
	}

	const worktreePath = planGitWorktreePath(repository.mainCheckout, branch);
	if (await pathExists(worktreePath)) throw new Error(`Checkout path already exists: ${worktreePath}`);
	const args = ["worktree", "add"];
	if (branchExists) {
		if (options.base) throw new Error("base cannot be used when the Git branch already exists");
		args.push("--no-guess-remote", worktreePath, branch);
	} else {
		let base = options.base;
		if (!base) {
			const head = await git(pi, ["rev-parse", "--verify", "HEAD^{commit}"], signal, currentDirectory, 10_000);
			base = head.stdout.trim();
		}
		args.push("--no-track", "-b", branch, worktreePath, base);
	}
	await git(pi, args, signal, repository.mainCheckout, 120_000);
	return { worktreePath: await canonicalDirectory(worktreePath), branch };
}

async function relocateWithoutMultiplexer(
	_pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	jump: PendingJump,
	newSessionFile: string,
): Promise<void> {
	const oldSessionFile = jump.oldSessionFile;
	const worktreePath = jump.target.worktreePath;
	let replacementActivated = false;
	let result: Awaited<ReturnType<ExtensionCommandContext["switchSession"]>>;
	try {
		result = await ctx.switchSession(newSessionFile, {
			withSession: async (newCtx) => {
				replacementActivated = true;
				try {
					await rm(oldSessionFile, { force: true });
				} catch (error) {
					newCtx.ui.notify(`Moved sessions, but could not remove the source session: ${errorMessage(error)}`, "warning");
				}
				newCtx.ui.setStatus(STATUS_KEY, undefined);
				newCtx.ui.notify(`Moved Pi session to ${worktreePath}`, "info");
				void newCtx.sendUserMessage(`Moved to worktree ${worktreePath}. Continue.`).catch((error) => {
					newCtx.ui.notify(`Could not start the continuation turn: ${errorMessage(error)}`, "error");
				});
			},
		});
	} catch (error) {
		if (!replacementActivated) {
			await rm(newSessionFile, { force: true }).catch(() => undefined);
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
		throw error;
	}
	if (result.cancelled) {
		await rm(newSessionFile, { force: true });
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify("Worktree relocation was cancelled; the checkout was retained", "warning");
		return;
	}
}

async function relocateWithHerdr(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	jump: PendingJump,
	newSessionFile: string,
): Promise<void> {
	const oldPaneId = process.env.HERDR_PANE_ID;
	if (!oldPaneId) throw new Error("HERDR_PANE_ID is missing; cannot close the old Herdr pane safely");

	let target: Awaited<ReturnType<typeof openHerdrTarget>>;
	try {
		target = await openHerdrTarget(
			pi,
			ctx.signal,
			jump.repository.mainCheckout,
			jump.target.worktreePath,
			jump.label,
		);
	} catch (error) {
		await rm(newSessionFile, { force: true }).catch(() => undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		throw error;
	}
	const readyFile = join(tmpdir(), `pi-gibbon-${randomUUID()}.ready`);
	await rm(readyFile, { force: true });
	try {
		await runInHerdrPane(pi, ctx.signal, target.rootPaneId, newSessionFile, jump.target.worktreePath, readyFile);
		await waitForReadyFile(readyFile, ctx.signal, 60_000);
	} catch (error) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		let closeFailure: unknown;
		try {
			await herdr(pi, ["pane", "close", target.rootPaneId], undefined, jump.target.worktreePath, 10_000);
		} catch (closeError) {
			closeFailure = closeError;
		}
		if (closeFailure) {
			throw new Error(
				`${errorMessage(error)}. The replacement pane could not be closed, so its forked session was retained: ${errorMessage(closeFailure)}`,
			);
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 200));
		await rm(newSessionFile, { force: true });
		throw new Error(`${errorMessage(error)}. The replacement pane was closed and the old session remains active`);
	} finally {
		await rm(readyFile, { force: true }).catch(() => undefined);
	}

	let focusWarning: string | undefined;
	try {
		// Herdr has no atomic conditional-focus command. Resolve the pane's live
		// workspace immediately before focusing to keep this race window minimal.
		if (await currentHerdrWorkspaceIsFocused(pi, jump.repository.mainCheckout)) {
			await focusHerdrTarget(pi, target, jump.target.worktreePath);
		}
	} catch (error) {
		focusWarning = errorMessage(error);
	}

	let cleanupWarning: string | undefined;
	try {
		await scheduleOldHerdrPaneCleanup(pi, jump.oldSessionFile, oldPaneId, process.pid);
	} catch (error) {
		cleanupWarning = errorMessage(error);
	}
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.notify(`Moved Pi session to Herdr worktree ${jump.target.worktreePath}`, "info");
	if (focusWarning) {
		ctx.ui.notify(`Destination was left in the background because focus could not be preserved safely: ${focusWarning}`, "warning");
	}
	if (cleanupWarning) ctx.ui.notify(`Old pane cleanup warning: ${cleanupWarning}`, "warning");
	ctx.shutdown();
}

async function openHerdrTarget(
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	mainCheckout: string,
	worktreePath: string,
	label?: string,
): Promise<{ workspaceId: string; tabId?: string; rootPaneId: string }> {
	const args = ["worktree", "open", "--cwd", mainCheckout, "--path", worktreePath, "--no-focus"];
	if (label) args.push("--label", label);
	const response = await herdrJson<WorktreeOpened>(pi, args, signal, mainCheckout, 30_000);
	const workspaceId = response.result?.workspace?.workspace_id;
	if (!workspaceId) throw new Error("Herdr worktree open response did not include workspace.workspace_id");

	if (response.result?.already_open) {
		const tabResponse = await herdrJson<TabCreated>(
			pi,
			["tab", "create", "--workspace", workspaceId, "--cwd", worktreePath, "--no-focus"],
			signal,
			worktreePath,
			10_000,
		);
		const tabId = tabResponse.result?.tab?.tab_id;
		const rootPaneId = tabResponse.result?.root_pane?.pane_id;
		if (!tabId || !rootPaneId) {
			throw new Error("Herdr tab create response did not include tab.tab_id and root_pane.pane_id");
		}
		return { workspaceId, tabId, rootPaneId };
	}

	const rootPaneId = response.result?.root_pane?.pane_id;
	if (!rootPaneId) throw new Error("Herdr worktree open response did not include root_pane.pane_id");
	return { workspaceId, tabId: response.result?.tab?.tab_id, rootPaneId };
}

async function currentHerdrWorkspaceIsFocused(
	pi: ExtensionAPI,
	cwd: string,
): Promise<boolean> {
	const paneResponse = await herdrJson<PaneCurrent>(
		pi,
		["pane", "current", "--current"],
		undefined,
		cwd,
		10_000,
	);
	const workspaceId = paneResponse.result?.pane?.workspace_id;
	if (!workspaceId) throw new Error("Herdr pane current response did not include pane.workspace_id");

	const workspaceResponse = await herdrJson<WorkspaceInfo>(
		pi,
		["workspace", "get", workspaceId],
		undefined,
		cwd,
		10_000,
	);
	return workspaceResponse.result?.workspace?.workspace_id === workspaceId &&
		workspaceResponse.result.workspace.focused === true;
}

async function focusHerdrTarget(
	pi: ExtensionAPI,
	target: { workspaceId: string; tabId?: string },
	cwd: string,
): Promise<void> {
	await herdr(pi, ["workspace", "focus", target.workspaceId], undefined, cwd, 10_000);
	if (target.tabId) await herdr(pi, ["tab", "focus", target.tabId], undefined, cwd, 10_000);
}

async function runInHerdrPane(
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	paneId: string,
	sessionFile: string,
	worktreePath: string,
	readyFile: string,
): Promise<void> {
	const continuation = `Moved to worktree ${worktreePath}. Continue.`;
	const command = ["env", `PI_GIBBON_READY_FILE=${readyFile}`, "pi", "--session", sessionFile, continuation]
		.map(shellQuote)
		.join(" ");
	await herdr(pi, ["pane", "run", paneId, command], signal, worktreePath, 10_000);
}

async function waitForReadyFile(
	path: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Aborted");
		if (await pathExists(path)) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
	throw new Error(`Replacement Pi did not become ready within ${timeoutMs / 1000} seconds`);
}

async function scheduleOldHerdrPaneCleanup(
	pi: ExtensionAPI,
	oldSessionFile: string,
	oldPaneId: string,
	oldPid: number,
): Promise<void> {
	const launcher = buildOldPaneCleanupLauncher(oldSessionFile, oldPaneId, oldPid);
	const result = await pi.exec("sh", ["-lc", launcher], { timeout: 5_000 });
	if (result.code !== 0) throw new Error(result.stderr || result.stdout || "failed to launch cleanup process");
}

async function forkSessionFile(currentFile: string, worktreePath: string): Promise<string> {
	const forked = SessionManager.forkFrom(currentFile, worktreePath);
	const newFile = forked.getSessionFile();
	if (!newFile) throw new Error("Failed to create forked Pi session file for the destination worktree");

	const raw = await readFile(newFile, "utf8");
	const lines = raw.trimEnd().split("\n");
	if (lines[0]) {
		const header = JSON.parse(lines[0]) as Record<string, unknown>;
		if (header.parentSession !== undefined) {
			delete header.parentSession;
			lines[0] = JSON.stringify(header);
			await writeFile(newFile, `${lines.join("\n")}\n`, "utf8");
		}
	}
	return newFile;
}

async function executableExists(
	pi: ExtensionAPI,
	name: "wt" | "herdr",
	signal: AbortSignal | undefined,
	cwd: string,
): Promise<boolean> {
	const result = await pi.exec("sh", ["-lc", `command -v ${name} >/dev/null 2>&1`], {
		cwd,
		signal,
		timeout: 5_000,
	});
	if (signal?.aborted || result.killed) throw new Error("Aborted");
	return result.code === 0;
}

async function validateBranch(
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	cwd: string,
	branch: string,
): Promise<void> {
	if (branch === "@") throw new Error("@ is a Worktrunk shortcut, not a valid destination branch name");
	const result = await pi.exec("git", ["check-ref-format", "--branch", branch], { cwd, signal, timeout: 10_000 });
	if (signal?.aborted || result.killed) throw new Error("Aborted");
	if (result.code !== 0) throw new Error(result.stderr.trim() || `Invalid branch name: ${branch}`);
}

async function localBranchExists(
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	cwd: string,
	branch: string,
): Promise<boolean> {
	const result = await pi.exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
		cwd,
		signal,
		timeout: 10_000,
	});
	if (signal?.aborted || result.killed) throw new Error("Aborted");
	if (result.code !== 0 && result.code !== 1) {
		throw new Error(result.stderr.trim() || "failed to check whether the branch already exists");
	}
	return result.code === 0;
}

async function currentBranch(
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	cwd: string,
): Promise<string | undefined> {
	const result = await pi.exec("git", ["branch", "--show-current"], { cwd, signal, timeout: 10_000 });
	if (signal?.aborted || result.killed) throw new Error("Aborted");
	return result.code === 0 ? cleanOptional(result.stdout) : undefined;
}

async function git(
	pi: ExtensionAPI,
	args: string[],
	signal: AbortSignal | undefined,
	cwd: string,
	timeout: number,
) {
	const result = await pi.exec("git", args, { cwd, signal, timeout });
	if (signal?.aborted || result.killed) throw new Error("Aborted");
	if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	return result;
}

async function worktrunkJson<T>(
	pi: ExtensionAPI,
	args: string[],
	signal: AbortSignal | undefined,
	cwd: string,
	timeout: number,
): Promise<T> {
	const result = await pi.exec("wt", args, { cwd, signal, timeout });
	if (signal?.aborted || result.killed) throw new Error("Aborted");
	if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `wt ${args.join(" ")} failed`);
	const jsonLine = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.reverse()
		.find((line) => line.startsWith("{"));
	if (!jsonLine) throw new Error(`Worktrunk returned no JSON output for ${args.join(" ")}: ${result.stdout.trim()}`);
	try {
		return JSON.parse(jsonLine) as T;
	} catch {
		throw new Error(`Worktrunk returned invalid JSON for ${args.join(" ")}: ${jsonLine}`);
	}
}

async function herdrJson<T>(
	pi: ExtensionAPI,
	args: string[],
	signal: AbortSignal | undefined,
	cwd: string,
	timeout: number,
): Promise<HerdrEnvelope<T>> {
	const result = await herdr(pi, args, signal, cwd, timeout);
	const raw = result.stdout.trim() || result.stderr.trim();
	let response: HerdrEnvelope<T>;
	try {
		response = JSON.parse(raw) as HerdrEnvelope<T>;
	} catch {
		throw new Error(`Herdr returned non-JSON output for ${args.join(" ")}: ${raw}`);
	}
	if (response.error) {
		throw new Error(`${response.error.code ?? "herdr_error"}: ${response.error.message ?? "unknown Herdr error"}`);
	}
	return response;
}

async function herdr(
	pi: ExtensionAPI,
	args: string[],
	signal: AbortSignal | undefined,
	cwd: string,
	timeout: number,
) {
	const result = await pi.exec("herdr", args, { cwd, signal, timeout });
	if (signal?.aborted || result.killed) throw new Error("Aborted");
	if (result.code !== 0) throw new Error(parseHerdrFailure(result.stderr, result.stdout, args));
	return result;
}

function parseHerdrFailure(stderr: string, stdout: string, args: string[]): string {
	for (const output of [stderr, stdout]) {
		const trimmed = output.trim();
		if (!trimmed) continue;
		try {
			const response = JSON.parse(trimmed) as HerdrEnvelope<unknown>;
			if (response.error) {
				return `${response.error.code ?? "herdr_error"}: ${response.error.message ?? "unknown Herdr error"}`;
			}
		} catch {
			return trimmed;
		}
	}
	return `herdr ${args.join(" ")} failed`;
}

async function canonicalDirectory(path: string): Promise<string> {
	const resolved = resolve(path.replace(/^@/, ""));
	const info = await stat(resolved).catch(() => undefined);
	if (!info?.isDirectory()) throw new Error(`Directory does not exist: ${resolved}`);
	return realpath(resolved);
}

async function pathExists(path: string): Promise<boolean> {
	return lstat(path)
		.then(() => true)
		.catch((error) => {
			if (isNodeError(error) && error.code === "ENOENT") return false;
			throw error;
		});
}

function cleanOptional(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

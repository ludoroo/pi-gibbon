import { join, parse, resolve } from "node:path";

export const BACKEND_NAMES = ["auto", "worktrunk", "git"] as const;
export const MULTIPLEXER_NAMES = ["auto", "herdr", "tmux", "none"] as const;

export type BackendName = (typeof BACKEND_NAMES)[number];
export type ResolvedBackendName = Exclude<BackendName, "auto">;
export type MultiplexerName = (typeof MULTIPLEXER_NAMES)[number];
export type ResolvedMultiplexerName = Exclude<MultiplexerName, "auto">;

export type PiGibbonConfig = {
	backend: BackendName;
	multiplexer: MultiplexerName;
};

export type GitWorktree = {
	path: string;
	branch?: string;
	bare: boolean;
};

export const DEFAULT_CONFIG: PiGibbonConfig = {
	backend: "auto",
	multiplexer: "auto",
};

export function parseConfig(value: unknown): PiGibbonConfig {
	if (!isRecord(value)) {
		throw new Error("pi-gibbon config must be a JSON object");
	}
	const unknownKeys = Object.keys(value).filter((key) => key !== "backend" && key !== "multiplexer");
	if (unknownKeys.length > 0) {
		throw new Error(`pi-gibbon config has unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`);
	}

	return {
		backend: parseChoice("backend", value.backend, BACKEND_NAMES, DEFAULT_CONFIG.backend),
		multiplexer: parseChoice(
			"multiplexer",
			value.multiplexer,
			MULTIPLEXER_NAMES,
			DEFAULT_CONFIG.multiplexer,
		),
	};
}

export function resolveBackend(
	configured: BackendName,
	worktrunkAvailable: boolean,
): ResolvedBackendName {
	if (configured === "auto") return worktrunkAvailable ? "worktrunk" : "git";
	if (configured === "worktrunk" && !worktrunkAvailable) {
		throw new Error('Worktree backend "worktrunk" requires the wt executable');
	}
	return configured;
}

export function resolveMultiplexer(
	configured: MultiplexerName,
	herdrAvailable: boolean,
): ResolvedMultiplexerName {
	if (configured === "auto") return herdrAvailable ? "herdr" : "none";
	if (configured === "herdr" && !herdrAvailable) {
		throw new Error('Multiplexer "herdr" requires HERDR_ENV=1, HERDR_PANE_ID, and the herdr executable');
	}
	return configured;
}

export function parseGitWorktrees(raw: string): GitWorktree[] {
	const worktrees: GitWorktree[] = [];
	let current: GitWorktree | undefined;

	for (const field of raw.split("\0")) {
		if (!field) {
			if (current) worktrees.push(current);
			current = undefined;
			continue;
		}
		if (field.startsWith("worktree ")) {
			if (current) worktrees.push(current);
			current = { path: field.slice("worktree ".length), bare: false };
		} else if (current && field.startsWith("branch refs/heads/")) {
			current.branch = field.slice("branch refs/heads/".length);
		} else if (current && field === "bare") {
			current.bare = true;
		}
	}
	if (current) worktrees.push(current);
	return worktrees;
}

export function planGitWorktreePath(mainCheckout: string, branch: string): string {
	const { dir, base } = parse(resolve(mainCheckout));
	const slug = branch.replaceAll("/", "-");
	return join(dir, `.${base}-${slug}`);
}

export function dispatchPending<T>(
	pending: Map<string, T>,
	token: string,
	value: T,
	dispatch: () => void,
): void {
	pending.set(token, value);
	try {
		dispatch();
	} catch (error) {
		pending.delete(token);
		throw error;
	}
}

export type PendingOutcome = "missing" | "cancelled" | "finalized";

export async function consumePending<T>(
	pending: Map<string, T>,
	token: string,
	waitForIdle: () => Promise<void>,
	shouldFinalize: (value: T) => boolean,
	finalize: (value: T) => Promise<void>,
): Promise<PendingOutcome> {
	const value = pending.get(token);
	if (value === undefined) return "missing";
	pending.delete(token);
	await waitForIdle();
	if (!shouldFinalize(value)) return "cancelled";
	await finalize(value);
	return "finalized";
}

function parseChoice<T extends readonly string[]>(
	field: string,
	value: unknown,
	choices: T,
	fallback: T[number],
): T[number] {
	if (value === undefined) return fallback;
	if (typeof value === "string" && choices.includes(value)) return value as T[number];
	throw new Error(`Invalid ${field}: ${String(value)} (expected ${choices.join(", ")})`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

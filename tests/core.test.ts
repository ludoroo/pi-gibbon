import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_CONFIG,
	consumePending,
	dispatchPending,
	parseConfig,
	parseGitWorktrees,
	planGitWorktreePath,
	resolveBackend,
	resolveMultiplexer,
} from "../src/core.ts";

test("config defaults and validates both adapter axes", () => {
	assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
	assert.deepEqual(parseConfig({ backend: "git", multiplexer: "none" }), {
		backend: "git",
		multiplexer: "none",
	});
	assert.throws(() => parseConfig({ backend: "herdr" }), /Invalid backend/);
	assert.throws(() => parseConfig({ multiplexer: "screen" }), /Invalid multiplexer/);
	assert.throws(() => parseConfig({ backend: "auto", extra: true }), /unknown field: extra/);
});

test("backend auto mode prefers Worktrunk and otherwise falls back to Git", () => {
	assert.equal(resolveBackend("auto", undefined, true), "worktrunk");
	assert.equal(resolveBackend("auto", undefined, false), "git");
	assert.equal(resolveBackend("worktrunk", "git", false), "git");
	assert.throws(() => resolveBackend("worktrunk", undefined, false), /requires the wt executable/);
});

test("multiplexer auto mode uses Herdr only when its runtime is available", () => {
	assert.equal(resolveMultiplexer("auto", undefined, true), "herdr");
	assert.equal(resolveMultiplexer("auto", undefined, false), "none");
	assert.equal(resolveMultiplexer("herdr", "none", false), "none");
	assert.throws(() => resolveMultiplexer("herdr", undefined, false), /requires HERDR_ENV=1/);
	assert.equal(resolveMultiplexer("auto", "tmux", true), "tmux");
});

test("Git porcelain parsing keeps primary order, detached state, and bare state", () => {
	const raw =
		"worktree /repo\0HEAD aaaa\0branch refs/heads/main\0\0" +
		"worktree /repo-feature\0HEAD bbbb\0detached\0\0" +
		"worktree /repo-bare\0bare\0\0";
	assert.deepEqual(parseGitWorktrees(raw), [
		{ path: "/repo", branch: "main", bare: false },
		{ path: "/repo-feature", bare: false },
		{ path: "/repo-bare", bare: true },
	]);
});

test("pending relocation is visible to synchronous command dispatch and finalizes only after idle", async () => {
	const pending = new Map<string, { path: string }>();
	let releaseIdle: (() => void) | undefined;
	const idle = new Promise<void>((resolve) => {
		releaseIdle = resolve;
	});
	let finalized = false;
	let consume: Promise<"missing" | "cancelled" | "finalized"> | undefined;

	dispatchPending(pending, "token", { path: "/repo-feature" }, () => {
		consume = consumePending(
			pending,
			"token",
			() => idle,
			() => true,
			async () => {
				finalized = true;
			},
		);
	});

	assert.equal(finalized, false);
	releaseIdle?.();
	assert.equal(await consume, "finalized");
	assert.equal(finalized, true);
	assert.equal(pending.size, 0);
});

test("aborted pending relocation settles without finalizing", async () => {
	const pending = new Map([["token", { aborted: true }]]);
	let finalized = false;
	const outcome = await consumePending(
		pending,
		"token",
		async () => undefined,
		(value) => !value.aborted,
		async () => {
			finalized = true;
		},
	);
	assert.equal(outcome, "cancelled");
	assert.equal(finalized, false);
	assert.equal(pending.size, 0);
});

test("failed dispatch removes its pending relocation", () => {
	const pending = new Map<string, number>();
	assert.throws(
		() => dispatchPending(pending, "token", 1, () => { throw new Error("dispatch failed"); }),
		/dispatch failed/,
	);
	assert.equal(pending.size, 0);
});

test("native Git path planning mirrors the dot-sibling Worktrunk layout", () => {
	assert.equal(planGitWorktreePath("/work/repo", "feature/test"), "/work/.repo-feature-test");
});

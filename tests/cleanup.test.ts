import assert from "node:assert/strict";
import test from "node:test";
import {
	buildDetachedCleanupCommand,
	buildOldPaneCleanupLauncher,
	shellQuote,
} from "../src/cleanup.ts";

test("shell quoting preserves single quotes without interpolation", () => {
	assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
});

test("portable cleanup selects setsid when available and nohup otherwise", () => {
	const cleanup = "echo safe";
	assert.match(buildDetachedCleanupCommand(cleanup, true), /^setsid sh -c /);
	assert.match(buildDetachedCleanupCommand(cleanup, false), /^nohup sh -c /);

	const launcher = buildOldPaneCleanupLauncher("/tmp/session with ' quote", "w1:p2", 1234);
	assert.match(launcher, /if command -v setsid/);
	assert.match(launcher, /then setsid sh -c/);
	assert.match(launcher, /else nohup sh -c/);
});

test("old-pane cleanup is conservative when the source process does not exit", () => {
	const launcher = buildOldPaneCleanupLauncher("/tmp/session", "w1:p2", 1234);
	assert.match(launcher, /\[ "\$i" -lt 60 \]/);
	assert.match(launcher, /kill -0 "\$old_pid" 2>\/dev\/null && exit 0/);
	assert.ok(launcher.indexOf('kill -0 "$old_pid" 2>/dev/null && exit 0') < launcher.indexOf('rm -f -- "$old_session"'));
	assert.ok(launcher.indexOf('rm -f -- "$old_session"') < launcher.indexOf('herdr pane close "$old_pane"'));
});

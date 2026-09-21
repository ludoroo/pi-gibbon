import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import piGibbon from "../src/index.ts";

type Registered = Record<string, unknown> & { name?: string };

function registerExtension() {
	const tools: Registered[] = [];
	const commands = new Map<string, Registered>();
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const pi = {
		on(event: string, handler: (...args: any[]) => unknown) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: Registered) {
			commands.set(name, command);
		},
		registerTool(tool: Registered) {
			tools.push(tool);
		},
	};
	piGibbon(pi as any);
	return { commands, handlers, tools };
}

test("registers exactly one stable tool and one private finalize command", () => {
	const { commands, tools } = registerExtension();
	assert.deepEqual(tools.map((tool) => tool.name), ["worktree_jump"]);
	assert.deepEqual([...commands.keys()], ["worktree-jump"]);
	assert.match(String(tools[0]?.promptSnippet), /only when explicitly requested/);
	assert.match(String((tools[0]?.promptGuidelines as string[]).join("\n")), /Never use worktree_jump merely because isolation/);
});

test("legacy Herdr backend arguments retain their compatibility mapping", () => {
	const { tools } = registerExtension();
	const prepareArguments = tools[0]?.prepareArguments as (args: Record<string, unknown>) => Record<string, unknown>;
	assert.deepEqual(prepareArguments({ backend: "herdr", branch: "feature/test" }), {
		backend: "git",
		multiplexer: "herdr",
		branch: "feature/test",
	});
	assert.deepEqual(prepareArguments({ backend: "git", multiplexer: "none" }), {
		backend: "git",
		multiplexer: "none",
	});
});

test("session_start publishes and consumes the replacement readiness marker", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-gibbon-ready-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const readyFile = join(root, "ready");
	const previous = process.env.PI_GIBBON_READY_FILE;
	process.env.PI_GIBBON_READY_FILE = readyFile;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_GIBBON_READY_FILE;
		else process.env.PI_GIBBON_READY_FILE = previous;
	});

	const { handlers } = registerExtension();
	const handler = handlers.get("session_start");
	assert.ok(handler);
	await handler?.({ type: "session_start" }, { ui: { setStatus() {} } });
	assert.equal(await readFile(readyFile, "utf8"), `${process.pid}\n`);
	assert.equal(process.env.PI_GIBBON_READY_FILE, undefined);
});

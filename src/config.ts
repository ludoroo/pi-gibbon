import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG, parseConfig, type PiGibbonConfig } from "./core.ts";

export function resolveConfigPath(
	environment: NodeJS.ProcessEnv = process.env,
	agentDirectory: string = getAgentDir(),
): string {
	return environment.PI_GIBBON_CONFIG ?? join(agentDirectory, "pi-gibbon.json");
}

export async function loadConfig(path: string = resolveConfigPath()): Promise<PiGibbonConfig> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return DEFAULT_CONFIG;
		throw new Error(`Could not read pi-gibbon config ${path}: ${errorMessage(error)}`);
	}
	try {
		return parseConfig(JSON.parse(raw) as unknown);
	} catch (error) {
		throw new Error(`Invalid pi-gibbon config ${path}: ${errorMessage(error)}`);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

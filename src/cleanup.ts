export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildDetachedCleanupCommand(cleanup: string, hasSetsid: boolean): string {
	const launcher = hasSetsid ? "setsid" : "nohup";
	return `${launcher} sh -c ${shellQuote(cleanup)} >/dev/null 2>&1 < /dev/null & `;
}

export function buildOldPaneCleanupLauncher(
	oldSessionFile: string,
	oldPaneId: string,
	oldPid: number,
): string {
	const cleanup = [
		`old_pid=${oldPid}`,
		`old_session=${shellQuote(oldSessionFile)}`,
		`old_pane=${shellQuote(oldPaneId)}`,
		"i=0",
		'while kill -0 "$old_pid" 2>/dev/null && [ "$i" -lt 60 ]; do i=$((i + 1)); sleep 1; done',
		'kill -0 "$old_pid" 2>/dev/null && exit 0',
		'rm -f -- "$old_session"',
		'herdr pane close "$old_pane" >/dev/null 2>&1 || true',
	].join("; ");

	return (
		"if command -v setsid >/dev/null 2>&1; then " +
		buildDetachedCleanupCommand(cleanup, true) +
		"else " +
		buildDetachedCleanupCommand(cleanup, false) +
		"fi"
	);
}

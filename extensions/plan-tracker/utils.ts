/** Checklist normalization shared by live updates and branch reconstruction. */
export const TODO_STATUSES = ["pending", "in_progress", "waiting", "blocked", "completed", "cancelled"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoInput {
	id?: string;
	text: string;
	status?: TodoStatus;
	reason?: string;
	step?: number;
	/** Migration from the original plan-mode example. */
	completed?: boolean;
}

export interface TodoItem {
	id: string;
	step: number;
	text: string;
	status: TodoStatus;
	reason?: string;
}

const clean = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();

/** Reject ambiguous caller-supplied identities before changing any state. */
export function validateTodoIds(items: TodoInput[]): void {
	const ids = new Set<string>();
	for (const item of items) {
		if (item.id === undefined) continue;
		const id = clean(item.id);
		if (!id) throw new Error("Todo IDs must not be empty.");
		if (ids.has(id)) throw new Error(`Duplicate todo ID: ${id}`);
		ids.add(id);
	}
}

/**
 * Full-list replacement. Explicit IDs win; omitted IDs match normalized text
 * one-to-one, even across reordering. Reserve all explicit IDs first so an
 * earlier implicit match cannot steal a later explicit item's identity.
 * Legacy/malformed persisted duplicate IDs are repaired deterministically.
 */
export function normalizeTodoItems(
	items: TodoInput[],
	previous: TodoItem[] = [],
	allocateId?: () => string,
): TodoItem[] {
	let counter = 1;
	const allocate = allocateId ?? (() => `todo-${counter++}`);
	const normalized = items.map((item) => ({
		id: clean(item.id),
		text: clean(item.text),
		status: TODO_STATUSES.includes(item.status as TodoStatus)
			? item.status as TodoStatus
			: item.completed === true ? "completed" as const : "pending" as const,
		reason: clean(item.reason),
	})).filter((item) => item.text.length > 0);
	const explicitIds = new Set(normalized.map((item) => item.id).filter(Boolean));
	const reservedIds = new Set([...explicitIds, ...previous.map((item) => item.id)]);
	const usedIds = new Set<string>();

	return normalized.map((item, index) => {
		let id = item.id;
		if (!id || usedIds.has(id)) {
			id = previous.find((old) => old.text === item.text && !usedIds.has(old.id) && !explicitIds.has(old.id))?.id ?? "";
		}
		if (!id) {
			do { id = allocate(); } while (reservedIds.has(id) || usedIds.has(id));
		}
		usedIds.add(id);
		return {
			id,
			step: index + 1,
			text: item.text,
			status: item.status,
			...(item.reason ? { reason: item.reason } : {}),
		};
	});
}

export function isTodoCompleted(item: TodoItem): boolean {
	return item.status === "completed";
}

export function isTodoTerminal(item: TodoItem): boolean {
	return item.status === "completed" || item.status === "cancelled";
}

export type RunStatus = "queued" | "running" | "completed" | "failed" | "aborted";
export interface SubagentRun {
	id: string;
	task: string;
	taskId?: string;
	status: RunStatus;
	completionNotification?: string;
}
export interface SubagentSnapshot {
	version: 1;
	ownerSessionId: string;
	runs: SubagentRun[];
}

/** Event payloads are an external boundary; ignore malformed or foreign snapshots. */
export function readSubagentSnapshot(value: unknown, ownerSessionId: string): SubagentSnapshot | undefined {
	if (!value || typeof value !== "object") return;
	const snapshot = value as Partial<SubagentSnapshot>;
	if (snapshot.version !== 1 || snapshot.ownerSessionId !== ownerSessionId || !Array.isArray(snapshot.runs)) return;
	const ids = new Set<string>();
	const runs: SubagentRun[] = [];
	for (const run of snapshot.runs) {
		if (!run || typeof run.id !== "string" || !run.id || ids.has(run.id) || typeof run.task !== "string" ||
			!["queued", "running", "completed", "failed", "aborted"].includes(run.status)) continue;
		ids.add(run.id);
		runs.push({
			id: run.id,
			task: run.task,
			status: run.status,
			...(typeof run.taskId === "string" ? { taskId: run.taskId } : {}),
			...(typeof run.completionNotification === "string" ? { completionNotification: run.completionNotification } : {}),
		});
	}
	return { version: 1, ownerSessionId, runs };
}

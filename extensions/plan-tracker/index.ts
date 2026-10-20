/** Main-agent-owned checklist, with an optional read-only planning gate. */
import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { VERSION, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	TODO_STATUSES, isTodoCompleted, isTodoTerminal, normalizeTodoItems, readSubagentSnapshot, validateTodoIds,
	type SubagentRun, type TodoInput, type TodoItem, type TodoStatus,
} from "./utils.ts";

const TODO_TOOL = "todo_write";
const STATE_TYPE = "plan-mode"; // Preserve compatibility with existing branches.
const CONTEXT_TYPE = "plan-tracker-context";
const OWN_CONTEXT_TYPES = new Set([CONTEXT_TYPE, "plan-mode-context", "plan-execution-context"]);
// Deliberately not shell parsing or unverified third-party readOnlyHint annotations.
const SAFE_TOOLS = new Set(["read", "grep", "find", "ls", "questionnaire", TODO_TOOL, "subagent_control"]);
const SAFE_CONTROL_ACTIONS = new Set(["list", "status", "stop"]);
const PLAN_WARNING = "Plan mode enabled. Bash and unapproved tools are blocked. This does not undo or stop already-running work; review existing jobs and stop them explicitly if needed.";

interface PlanModeState {
	version?: number;
	enabled: boolean;
	todos?: TodoInput[];
	executing?: boolean;
	nextTodoId?: number;
	toolsBeforePlanMode?: string[] | null;
	/** Ordinary loadout captured with this snapshot; not authoritative over newer transcript policy. */
	normalTools?: string[];
}
interface TodoWriteDetails {
	version: 2;
	todos: TodoItem[];
	completed: number;
	cancelled: number;
	total: number;
}

const TodoWriteParams = Type.Object({
	todos: Type.Array(Type.Object({
		id: Type.Optional(Type.String({ minLength: 1, description: "Stable item ID. Reuse existing IDs when editing or renaming tasks; omit for a new task." })),
		text: Type.String({ minLength: 1, description: "Todo text" }),
		status: StringEnum(TODO_STATUSES),
		reason: Type.Optional(Type.String({ description: "Optional explanation, especially for waiting, blocked, or cancelled tasks." })),
	}), { description: "The complete current checklist, including completed and cancelled tasks. Omitted items are removed; [] explicitly clears it." }),
});

function statusGlyph(status: TodoStatus): string {
	return { pending: "☐", in_progress: "▶", waiting: "◷", blocked: "!", completed: "☑", cancelled: "⊘" }[status];
}
function todoText(todo: TodoItem): string {
	return `${todo.text}${todo.reason ? ` — ${todo.reason}` : ""}`;
}
function plainTodoList(todos: TodoItem[]): string {
	return todos.map((todo) => `${todo.step}. ${statusGlyph(todo.status)} [${todo.id}] (${todo.status}) ${todoText(todo)}`).join("\n") || "No todos";
}
function themedTodoLine(todo: TodoItem, theme: Theme): string {
	const color = todo.status === "completed" ? "success" : todo.status === "blocked" ? "error"
		: todo.status === "waiting" ? "warning" : todo.status === "in_progress" ? "accent" : "muted";
	const text = isTodoTerminal(todo) ? theme.strikethrough(todoText(todo)) : todoText(todo);
	return `${theme.fg(color, statusGlyph(todo.status))} ${theme.fg(color, text)}`;
}

export default function planModeExtension(pi: ExtensionAPI): void {
	const [major, minor] = VERSION.split(".").map(Number);
	if (major < 1 || (major === 1 && minor < 3)) throw new Error("pi-plan-tracker requires Pi 1.3.0 or newer (nested tool policy and final lifecycle boundary).");
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let nextTodoId = 1;
	let toolsBeforePlanMode: string[] | undefined;
	let normalTools: string[] | undefined;
	let appliedPlanTools: string[] | undefined;
	let runs: SubagentRun[] = [];
	let unsubscribe: (() => void)[] = [];
	let sessionEpoch = 0;
	let planNoticePending = false;

	pi.registerFlag("plan", {
		description: "Initialize a new session in read-only plan mode (does not override restored state)",
		type: "boolean",
		default: false,
	});

	const todoSnapshot = (): TodoItem[] => todoItems.map((todo) => ({ ...todo }));
	const allocateId = (): string => `todo-${nextTodoId++}`;
	const progress = () => ({
		completed: todoItems.filter(isTodoCompleted).length,
		cancelled: todoItems.filter((todo) => todo.status === "cancelled").length,
		total: todoItems.length,
	});
	function reconcileExecution(): void {
		if (planModeEnabled || !todoItems.some((todo) => !isTodoTerminal(todo))) executionMode = false;
	}
	function runBadges(todo: TodoItem): string {
		return runs.filter((run) => run.taskId === todo.id).map((run) =>
			`[${run.id}: ${run.status === "completed" ? isTodoTerminal(todo) ? "finished" : "finished; review" : run.status}]`).join(" ");
	}
	function unlinkedSummary(): string {
		const ids = new Set(todoItems.map((todo) => todo.id));
		const unlinked = runs.filter((run) => !run.taskId || !ids.has(run.taskId));
		if (unlinked.length === 0) return "";
		const statuses = ["queued", "running", "completed", "failed", "aborted"] as const;
		return `Unlinked jobs: ${statuses.map((status) => {
			const count = unlinked.filter((run) => run.status === status).length;
			return count ? `${count} ${status === "completed" ? "finished (review)" : status}` : "";
		}).filter(Boolean).join(", ")}`;
	}
	function updateStatus(ctx: ExtensionContext): void {
		const { completed, cancelled, total } = progress();
		// Keep the status uncoloured so no stale ANSI colours survive a theme change.
		const status = [planModeEnabled ? "⏸ plan" : "", total ? `📋 ${completed}/${total}${cancelled ? ` · ${cancelled} cancelled` : ""}` : ""].filter(Boolean).join(" · ");
		ctx.ui.setStatus("plan-mode", status || undefined);
		if (!total && !runs.length) {
			ctx.ui.setWidget("plan-todos", undefined);
			return;
		}
		if (ctx.mode !== "tui") {
			const lines = todoItems.map((todo) => `${statusGlyph(todo.status)} ${todoText(todo)}${runBadges(todo) ? ` ${runBadges(todo)}` : ""}`);
			const summary = unlinkedSummary();
			if (summary) lines.push(summary);
			ctx.ui.setWidget("plan-todos", lines);
			return;
		}
		ctx.ui.setWidget("plan-todos", (_tui, theme) => ({
			render(width) {
				const lines = todoItems.map((todo) => {
					const badges = runBadges(todo);
					return themedTodoLine(todo, theme) + (badges ? ` ${theme.fg("dim", badges)}` : "");
				});
				const summary = unlinkedSummary();
				if (summary) lines.push(theme.fg("dim", summary));
				return lines.map((line) => truncateToWidth(line, width));
			},
			invalidate() {}, // Theme colours are computed on every render.
		}));
	}

	function persistState(): void {
		// This entry, not a transcript tool result, is authoritative. Nested executeTool
		// calls do not create tool-result entries; parallel results can also arrive late.
		pi.appendEntry<PlanModeState>(STATE_TYPE, {
			version: 2,
			enabled: planModeEnabled,
			todos: todoSnapshot(),
			executing: executionMode,
			nextTodoId,
			toolsBeforePlanMode: toolsBeforePlanMode?.slice() ?? null,
			normalTools: normalTools?.slice(),
		});
	}
	function changed(ctx: ExtensionContext): void {
		reconcileExecution();
		if (!planModeEnabled) normalTools = pi.getActiveTools();
		persistState();
		updateStatus(ctx);
	}
	function planTools(): string[] {
		return pi.getAllTools().filter((tool) => SAFE_TOOLS.has(tool.name) && tool.exposure !== "hidden").map((tool) => tool.name);
	}
	function enablePlanTools(fallback = pi.getActiveTools()): void {
		toolsBeforePlanMode ??= fallback.slice();
		normalTools = toolsBeforePlanMode.slice();
		appliedPlanTools = planTools();
		pi.setActiveTools(appliedPlanTools);
	}
	function restoreTools(): void {
		if (toolsBeforePlanMode !== undefined) {
			normalTools = toolsBeforePlanMode.slice();
			pi.setActiveTools(normalTools);
		}
		toolsBeforePlanMode = undefined;
		appliedPlanTools = undefined;
	}
	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		planNoticePending = false;
		if (planModeEnabled) {
			enablePlanTools();
			ctx.ui.notify(PLAN_WARNING, "warning");
		} else {
			restoreTools();
			ctx.ui.notify("Plan mode disabled. Previous tool access restored; checklist retained.", "info");
		}
		changed(ctx);
	}

	function reconstructState(ctx: ExtensionContext): boolean {
		const activeTools = pi.getActiveTools();
		// Only undo our live restriction when Pi had no transcript policy to restore
		// and nobody has replaced our loadout. Never override an incoming checkpoint
		// merely because the outgoing branch happened to be in plan mode.
		const outgoingRestore = planModeEnabled && appliedPlanTools &&
			activeTools.length === appliedPlanTools.length && activeTools.every((name) => appliedPlanTools!.includes(name))
			? toolsBeforePlanMode?.slice() : undefined;
		planModeEnabled = false;
		executionMode = false;
		todoItems = [];
		nextTodoId = 1;
		toolsBeforePlanMode = undefined;
		normalTools = undefined;
		appliedPlanTools = undefined;
		planNoticePending = false;
		let restored = false;
		let lastToolCheckpoint = -1;
		let lastPlanExit = -1;
		let exitTools: string[] | undefined;
		const branch = ctx.sessionManager.getBranch();
		for (const [index, entry] of branch.entries()) {
			// Pi replays system deltas and compaction checkpoints before session_tree.
			// Even an instruction-only system delta carries forward that tool policy.
			if ((entry.type === "message" && entry.message.role === "system") ||
				(entry.type === "compaction" && entry.systemMessage)) lastToolCheckpoint = index;
			if (entry.type === "custom" && entry.customType === STATE_TYPE && entry.data) {
				const data = entry.data as PlanModeState;
				restored = true;
				const wasEnabled = planModeEnabled;
				planModeEnabled = data.enabled === true;
				executionMode = data.executing === true;
				// Full snapshots: a missing/undefined/null value explicitly clears the
				// old snapshot. Never use ?? previousSnapshot here.
				toolsBeforePlanMode = Array.isArray(data.toolsBeforePlanMode) ? data.toolsBeforePlanMode.slice() : undefined;
				normalTools = Array.isArray(data.normalTools) ? data.normalTools.slice() : undefined;
				if (wasEnabled && !planModeEnabled) {
					lastPlanExit = index;
					// Only this full snapshot can authorize restoration. A cleared
					// saved loadout must not resurrect tools from an earlier entry.
					exitTools = normalTools;
				} else if (!planModeEnabled && lastPlanExit >= 0) {
					exitTools = normalTools;
				}
				if (Array.isArray(data.todos)) todoItems = normalizeTodoItems(data.todos, todoItems, allocateId);
				if (Number.isSafeInteger(data.nextTodoId) && data.nextTodoId! > 0) nextTodoId = Math.max(nextTodoId, data.nextTodoId!);
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === TODO_TOOL) {
				const details = entry.message.details as Partial<TodoWriteDetails> | undefined;
				// Only migrate old results. V2 mutations already have durable custom
				// entries; replaying results would resurrect removed or stale tasks.
				if (!entry.message.isError && details?.version !== 2 && Array.isArray(details?.todos)) {
					todoItems = normalizeTodoItems(details.todos, todoItems, allocateId);
					restored = true;
				}
			}
		}
		reconcileExecution();
		if (planModeEnabled) enablePlanTools(activeTools);
		else {
			toolsBeforePlanMode = undefined;
			// /plan off is durable immediately, but Pi does not checkpoint the
			// restored tools until the next request. Undo that older plan checkpoint
			// only when the branch contains a later explicit exit from plan mode.
			if (lastPlanExit > lastToolCheckpoint && exitTools) pi.setActiveTools(exitTools);
			else if (lastToolCheckpoint < 0 && outgoingRestore) pi.setActiveTools(outgoingRestore);
			// Otherwise Pi's transcript-restored loadout is authoritative. In
			// particular, stale ordinary snapshots must never reactivate writes.
		}
		return restored;
	}

	function disposeSubscriptions(): void {
		sessionEpoch++;
		for (const off of unsubscribe.splice(0)) off();
		runs = [];
	}
	function connectSubagents(ctx: ExtensionContext): void {
		disposeSubscriptions();
		const epoch = sessionEpoch;
		const ownerSessionId = ctx.sessionManager.getSessionId();
		const isCurrent = () => epoch === sessionEpoch && ownerSessionId === ctx.sessionManager.getSessionId();
		const accept = (payload: unknown) => {
			if (!isCurrent()) return;
			const snapshot = readSubagentSnapshot(payload, ownerSessionId);
			if (!snapshot) return;
			runs = snapshot.runs;
			updateStatus(ctx); // Observational only: never change todo status or start a turn.
		};
		unsubscribe.push(pi.events.on("pi-subagent:state", accept));
		unsubscribe.push(pi.events.on("pi-plan:context-request", (payload: unknown) => {
			if (!isCurrent() || !payload || typeof payload !== "object") return;
			const request = payload as { ownerSessionId?: string; respond?: (state: { readOnly: boolean; taskId?: string }) => void };
			if (request.ownerSessionId !== ownerSessionId || typeof request.respond !== "function") return;
			const active = todoItems.filter((todo) => todo.status === "in_progress");
			request.respond({ readOnly: planModeEnabled, ...(active.length === 1 ? { taskId: active[0].id } : {}) });
		}));
		pi.events.emit("pi-subagent:snapshot-request", { ownerSessionId, respond: accept });
	}

	pi.registerTool({
		name: TODO_TOOL,
		label: "TodoWrite",
		description: "Replace the visible checklist in any mode. Pass the full list, including finished tasks; omitted items are removed. Stable IDs are returned and should be reused.",
		promptSnippet: "Maintain the main agent's visible checklist (independent of /plan)",
		promptGuidelines: [
			"Use todo_write for multi-step work in ordinary mode as well as plan mode; always pass the complete checklist and preserve completed/cancelled items unless intentionally removing them.",
			"Reuse item IDs, especially when renaming. Set in_progress before working; use waiting/blocked with a reason when appropriate. Only the main agent decides semantic completion.",
			"On a background completion notification, review the worker's result, integrate or verify it as needed, then update the checklist with todo_write. A finished worker does not automatically mean the task is completed.",
		],
		parameters: TodoWriteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			validateTodoIds(params.todos);
			// Fresh identities must not alias jobs linked to removed tasks or tasks
			// created independently on sibling branches.
			todoItems = normalizeTodoItems(params.todos, todoItems, () => `todo-${randomUUID()}`);
			changed(ctx);
			const counts = progress();
			return {
				content: [{ type: "text", text: `${counts.completed}/${counts.total} todos complete${counts.cancelled ? `; ${counts.cancelled} cancelled` : ""}\n${plainTodoList(todoItems)}` }],
				details: { version: 2, todos: todoSnapshot(), ...counts } satisfies TodoWriteDetails,
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("todo_write ")) + theme.fg("muted", `${Array.isArray(args.todos) ? args.todos.length : 0} item(s)`), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoWriteDetails | undefined;
			if (!details?.todos?.length) return new Text(theme.fg("dim", "No todos"), 0, 0);
			const todos = normalizeTodoItems(details.todos);
			const shown = expanded ? todos : todos.slice(0, 8);
			let text = shown.map((todo) => themedTodoLine(todo, theme)).join("\n");
			if (shown.length < todos.length) text += `\n${theme.fg("dim", `… ${todos.length - shown.length} more`)}`;
			return new Text(text, 0, 0);
		},
	});
	pi.registerCommand("plan", {
		description: "Toggle read-only planning; /plan off to exit, /plan execute to approve and start the plan",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (!action) {
				togglePlanMode(ctx);
				return;
			}
			if (action === "off") {
				if (planModeEnabled) togglePlanMode(ctx);
				else ctx.ui.notify("Plan mode is already disabled. Checklist retained.", "info");
				return;
			}
			if (action !== "execute") {
				ctx.ui.notify("Usage: /plan (toggle), /plan off, or /plan execute. Refine the checklist with an ordinary message while planning.", "info");
				return;
			}
			if (!planModeEnabled) {
				ctx.ui.notify("Plan mode is not enabled. Use /plan to enter planning first.", "info");
				return;
			}
			if (!todoItems.some((todo) => !isTodoTerminal(todo))) {
				ctx.ui.notify("No unfinished tasks to execute. The checklist is retained.", "info");
				return;
			}
			// No await/modal/idle wait: the approval, policy change, snapshot, and
			// queued turn are one synchronous command operation in this session.
			planModeEnabled = false;
			executionMode = true;
			planNoticePending = false;
			restoreTools();
			changed(ctx);
			pi.sendMessage({
				customType: "plan-mode-execute", display: true,
				content: `Execute the approved plan. Review waiting/blocked tasks before proceeding.\n\n${plainTodoList(todoItems)}\n\nUse todo_write for each status change; retain finished tasks.`,
			}, { deliverAs: "followUp", triggerTurn: true });
		},
	});
	pi.registerCommand("todos", {
		description: "Show the checklist, or /todos clear to explicitly remove it",
		handler: async (args, ctx) => {
			if (args.trim() === "clear") {
				todoItems = [];
				changed(ctx);
				ctx.ui.notify("Checklist cleared. Background jobs are unchanged.", "info");
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("Usage: /todos [clear]", "info");
				return;
			}
			ctx.ui.notify(`Checklist:\n${plainTodoList(todoItems)}${unlinkedSummary() ? `\n${unlinkedSummary()}` : ""}`, "info");
		},
	});
	pi.registerShortcut(Key.ctrlAlt("p"), { description: "Toggle plan mode", handler: async (ctx) => togglePlanMode(ctx) });

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;
		const registered = planTools().includes(event.toolName);
		const allowed = registered && (event.toolName !== "subagent_control" || SAFE_CONTROL_ACTIONS.has(String(event.input.action ?? "list")));
		if (!allowed) return { block: true, reason: `Plan mode: ${event.toolName} is blocked. Only registered read/grep/find/ls/questionnaire, todo_write, and subagent_control list/status/stop are allowed. Use /plan to restore previous tool access.` };
	});
	pi.on("user_bash", async () => {
		if (planModeEnabled) return { result: { output: "Plan mode: shell execution is disabled. Use /plan to restore previous tool access.", exitCode: 1, cancelled: false, truncated: false } };
	});

	// Replace only our own context on EVERY model-context build, including custom
	// background wake-ups and ordinary-mode requests. Never inspect user markers.
	pi.on("context", async (event) => {
		const messages = event.messages.filter((message) => !("customType" in message && OWN_CONTEXT_TYPES.has(message.customType)));
		const linked = todoItems.map((todo) => runBadges(todo) ? `${todo.id}: ${runBadges(todo)}` : "").filter(Boolean);
		messages.push({
			role: "custom",
			customType: CONTEXT_TYPE,
			display: false,
			timestamp: Date.now(),
			content: `${planModeEnabled ? "[PLAN MODE ACTIVE]\nRead-only planning. Bash and unapproved tools (including nested calls) are blocked. Existing work is NOT stopped or undone. Use todo_write to propose or refine the checklist; do not attempt writes." : "[CURRENT CHECKLIST]\nOrdinary tool access; the checklist is independent of /plan."}\n\n${plainTodoList(todoItems)}\n\nUse todo_write with the full list for each change; retain finished tasks and stable IDs. The main agent owns task outcomes. Review background results before marking tasks completed.${linked.length ? `\nLinked jobs:\n${linked.join("\n")}` : ""}${unlinkedSummary() ? `\n${unlinkedSummary()}` : ""}`,
		});
		return { messages };
	});
	pi.on("before_agent_start", async (event) => {
		planNoticePending = planModeEnabled && event.messageType === "user";
	});

	// Never hold settlement (or abort) on a dialog, and never request an automatic
	// continuation. Execution requires the explicit /plan execute command.
	pi.on("agent_before_settle", (event, ctx) => {
		if (!planNoticePending || event.continue || event.context.pendingMessages.length) return;
		planNoticePending = false;
		if (planModeEnabled && ctx.hasUI && event.outcome === "completed" && todoItems.some((todo) => !isTodoTerminal(todo))) {
			ctx.ui.notify("Plan ready. Use /plan execute to approve, or send a message to refine it. /plan exits without starting work.", "info");
		}
	});

	pi.on("session_start", async (event, ctx) => {
		const restored = reconstructState(ctx);
		const newSession = (event.reason === "startup" || event.reason === "new") && !ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
		if (!restored && newSession && pi.getFlag("plan") === true) {
			planModeEnabled = true;
			enablePlanTools();
		}
		changed(ctx); // Persist initialization/migration, including generated legacy IDs.
		connectSubagents(ctx); // Subscribe only after branch state has been reconstructed.
		if (planModeEnabled) ctx.ui.notify(PLAN_WARNING, "warning");
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		changed(ctx);
		connectSubagents(ctx);
		if (planModeEnabled) ctx.ui.notify(PLAN_WARNING, "warning");
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		disposeSubscriptions();
		planNoticePending = false;
		// Release our tool restriction, not the saved branch state. Reload will
		// reconstruct the enabled plan and its original unrestricted snapshot.
		if (toolsBeforePlanMode !== undefined) pi.setActiveTools(toolsBeforePlanMode);
		ctx.ui.setStatus("plan-mode", undefined);
		ctx.ui.setWidget("plan-todos", undefined);
	});
}

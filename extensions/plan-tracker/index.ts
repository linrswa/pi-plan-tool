/**
 * Plan Tracker Extension
 *
 * Claude Code-style plan/todo tracking for pi.
 * - /plan toggles read-only planning
 * - todo_write updates the visible checklist with pending/in_progress/completed
 * - /todos shows current progress
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum, type AssistantMessage, type TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { extractTodoItems, isSafeCommand, isTodoCompleted, normalizeTodoItems, type TodoItem, type TodoStatus } from "./utils.ts";

const TODO_TOOL = "todo_write";
const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", TODO_TOOL];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", TODO_TOOL];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

interface PlanModeState {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	toolsBeforePlanMode?: string[];
}

interface TodoWriteDetails {
	todos: TodoItem[];
	completed: number;
	total: number;
}

const TodoWriteParams = Type.Object({
	todos: Type.Array(
		Type.Object({
			text: Type.String({ description: "Todo text" }),
			status: StringEnum(TODO_STATUSES, { description: "pending, in_progress, or completed" }),
		}),
		{ description: "The complete current todo list. Always pass the full list, not just changed items." },
	),
});

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function statusGlyph(status: TodoStatus): string {
	switch (status) {
		case "completed":
			return "☑";
		case "in_progress":
			return "▶";
		default:
			return "☐";
	}
}

function plainTodoList(todos: TodoItem[]): string {
	return todos.map((todo) => `${todo.step}. ${statusGlyph(todo.status)} ${todo.text}`).join("\n") || "No todos";
}

function themedTodoLine(todo: TodoItem, theme: Theme): string {
	if (todo.status === "completed") {
		return `${theme.fg("success", "☑")} ${theme.fg("muted", theme.strikethrough(todo.text))}`;
	}
	if (todo.status === "in_progress") {
		return `${theme.fg("accent", "▶")} ${theme.fg("accent", todo.text)}`;
	}
	return `${theme.fg("dim", "☐")} ${theme.fg("muted", todo.text)}`;
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let toolsBeforePlanMode: string[] | undefined;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function todoSnapshot(): TodoItem[] {
		return todoItems.map((todo) => ({ step: todo.step, text: todo.text, status: todo.status }));
	}

	function progress(): { completed: number; total: number } {
		return { completed: todoItems.filter(isTodoCompleted).length, total: todoItems.length };
	}

	function updateStatus(ctx: ExtensionContext): void {
		const { completed, total } = progress();

		if (total > 0) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${total}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		if (total > 0) {
			ctx.ui.setWidget("plan-todos", todoItems.map((todo) => themedTodoLine(todo, ctx.ui.theme)));
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function uniqueToolNames(toolNames: string[]): string[] {
		return [...new Set(toolNames)];
	}

	function getPlanModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
			...PLAN_MODE_TOOLS,
		]);
	}

	function getNormalModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...NORMAL_MODE_TOOLS,
			...activeToolNames.filter((name) => !PLAN_MANAGED_TOOLS.has(name)),
		]);
	}

	function enablePlanModeTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
	}

	function restoreNormalModeTools(): void {
		pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
		toolsBeforePlanMode = undefined;
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoSnapshot(),
			executing: executionMode,
			toolsBeforePlanMode,
		});
	}

	function setTodos(todos: TodoItem[], ctx?: ExtensionContext): void {
		todoItems = normalizeTodoItems(todos);
		if (ctx) updateStatus(ctx);
	}

	function reconstructState(ctx: ExtensionContext): void {
		planModeEnabled = false;
		executionMode = false;
		todoItems = [];
		toolsBeforePlanMode = undefined;

		for (const entry of ctx.sessionManager.getBranch()) {
			const custom = entry as { type: string; customType?: string; data?: PlanModeState };
			if (custom.type === "custom" && custom.customType === "plan-mode" && custom.data) {
				planModeEnabled = custom.data.enabled ?? planModeEnabled;
				executionMode = custom.data.executing ?? executionMode;
				toolsBeforePlanMode = custom.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
				if (custom.data.todos) todoItems = normalizeTodoItems(custom.data.todos);
				continue;
			}

			if (entry.type !== "message") continue;
			const message = (entry as { message?: { role?: string; toolName?: string; details?: TodoWriteDetails } }).message;
			if (message?.role === "toolResult" && message.toolName === TODO_TOOL && message.details?.todos) {
				todoItems = normalizeTodoItems(message.details.todos);
			}
		}
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		todoItems = [];

		if (planModeEnabled) {
			enablePlanModeTools();
			ctx.ui.notify("Plan mode enabled. Built-in write tools disabled.");
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updateStatus(ctx);
		persistState();
	}

	pi.registerTool({
		name: TODO_TOOL,
		label: "TodoWrite",
		description:
			"Replace the current plan checklist. Use pending, in_progress, and completed statuses. Always pass the full list.",
		promptSnippet: "Update the visible plan checklist with pending/in_progress/completed statuses",
		promptGuidelines: [
			"Use todo_write to create or update the plan checklist; always pass the complete current list.",
			"Use todo_write to mark one item in_progress before working on it and completed after it is done.",
		],
		parameters: TodoWriteParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			setTodos(
				params.todos.map((todo, index) => ({ step: index + 1, text: todo.text, status: todo.status as TodoStatus })),
				ctx,
			);

			const { completed, total } = progress();
			return {
				content: [{ type: "text", text: `${completed}/${total} todos complete\n${plainTodoList(todoItems)}` }],
				details: { todos: todoSnapshot(), completed, total } as TodoWriteDetails,
			};
		},

		renderCall(args, theme) {
			const count = Array.isArray(args.todos) ? args.todos.length : 0;
			return new Text(theme.fg("toolTitle", theme.bold("todo_write ")) + theme.fg("muted", `${count} item(s)`), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoWriteDetails | undefined;
			const todos = normalizeTodoItems(details?.todos ?? []);
			if (todos.length === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);

			const shown = expanded ? todos : todos.slice(0, 8);
			let text = shown.map((todo) => themedTodoLine(todo, theme)).join("\n");
			if (!expanded && todos.length > shown.length) {
				text += `\n${theme.fg("dim", `… ${todos.length - shown.length} more`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			ctx.ui.notify(`Plan Progress:\n${plainTodoList(todoItems)}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Block destructive bash commands in plan mode.
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// Filter stale injected context when not planning/executing.
	pi.on("context", async (event) => {
		if (planModeEnabled || executionMode) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context" || msg.customType === "plan-execution-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]") && !content.includes("[EXECUTING PLAN]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) =>
							c.type === "text" &&
							((c as TextContent).text?.includes("[PLAN MODE ACTIVE]") ||
								(c as TextContent).text?.includes("[EXECUTING PLAN]")),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before agent starts.
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in read-only planning mode.

Restrictions:
- Built-in edit and write tools are disabled
- Bash is restricted to an allowlist of read-only commands

Explore first. When you have a plan, use todo_write with the complete checklist and pending statuses, then show a concise numbered Plan: section.
Do NOT modify files in plan mode.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN]
Full tool access is enabled.

Current checklist:
${plainTodoList(todoItems)}

Use todo_write like Claude Code:
- before a step: set exactly that step to in_progress
- after finishing it: set that step to completed
- always pass the complete current list`,
					display: false,
				},
			};
		}
	});

	// Handle plan completion and plan mode UI.
	pi.on("agent_end", async (event, ctx) => {
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every(isTodoCompleted)) {
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${plainTodoList(todoItems)}`, display: true },
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				updateStatus(ctx);
				persistState();
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		if (todoItems.length === 0) {
			const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
			if (lastAssistant) setTodos(extractTodoItems(getTextContent(lastAssistant)), ctx);
		}

		if (todoItems.length === 0) return;
		persistState();

		const planTodoListMessage = {
			customType: "plan-todo-list",
			content: `**Plan Steps (${todoItems.length}):**\n\n${plainTodoList(todoItems)}`,
			display: true,
		};

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan (track progress)",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			const firstTodoItem = todoItems.find((todo) => todo.status !== "completed");
			if (!firstTodoItem) return;

			planModeEnabled = false;
			executionMode = true;
			restoreNormalModeTools();
			updateStatus(ctx);
			persistState();

			const execMessage = `Execute the plan.\n\nCurrent checklist:\n${plainTodoList(todoItems)}\n\nStart with: ${firstTodoItem.text}\nUse todo_write for every status change.`;
			pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		if (pi.getFlag("plan") === true) planModeEnabled = true;
		if (planModeEnabled) enablePlanModeTools();
		updateStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		if (planModeEnabled) enablePlanModeTools();
		updateStatus(ctx);
	});
}

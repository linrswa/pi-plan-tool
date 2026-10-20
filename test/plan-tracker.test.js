import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import planModeExtension from "../extensions/plan-tracker/index.ts";
import { TODO_STATUSES, isTodoCompleted, isTodoTerminal, normalizeTodoItems, readSubagentSnapshot, validateTodoIds } from "../extensions/plan-tracker/utils.ts";

const clone = (value) => structuredClone(value);
const theme = {
	fg: (_name, value) => String(value),
	bold: (value) => String(value),
	strikethrough: (value) => `~~${value}~~`,
};
function makeBus() {
	const emitter = new EventEmitter();
	return {
		emit: (name, payload) => emitter.emit(name, payload),
		on(name, fn) { emitter.on(name, fn); return () => emitter.off(name, fn); },
		count: (name) => emitter.listenerCount(name),
	};
}
function makeCtx({ branch = [], sessionId = "session-a", selectValue, editorValue = "", hasUI = true } = {}) {
	const ctx = {
		hasUI, mode: hasUI ? "tui" : "print", branch: clone(branch), sessionId,
		statuses: new Map(), widgets: new Map(), notifications: [], selections: [], editors: [],
		selectValue, editorValue,
	};
	ctx.sessionManager = { getBranch: () => ctx.branch, getSessionId: () => ctx.sessionId };
	ctx.ui = {
		theme: { ...theme },
		setStatus: (name, value) => ctx.statuses.set(name, value),
		setWidget: (name, value) => ctx.widgets.set(name, value),
		notify: (message, type) => ctx.notifications.push({ message, type }),
		select: async (...args) => { ctx.selections.push(args); return typeof ctx.selectValue === "function" ? ctx.selectValue() : ctx.selectValue; },
		editor: async (...args) => { ctx.editors.push(args); return ctx.editorValue; },
	};
	ctx.render = (width = 300) => {
		const widget = ctx.widgets.get("plan-todos");
		return typeof widget === "function" ? widget({}, ctx.ui.theme).render(width) : widget ?? [];
	};
	return ctx;
}
function install({ ctx = makeCtx(), activeTools = ["read", "bash", "edit", "write", "custom_tool"], flagPlan = false, bus = makeBus(), registered } = {}) {
	let active = [...activeTools];
	const builtins = registered ?? ["read", "bash", "edit", "write", "grep", "find", "ls", "questionnaire", "custom_tool", "subagent", "subagent_control", "schedule", "codemode", "safe_claim"];
	const pi = {
		ctx, events: bus, flags: new Map(), tools: new Map(), commands: new Map(), shortcuts: [], handlers: new Map(),
		allTools: builtins.map((name) => ({ name, exposure: "direct", annotations: name === "safe_claim" ? { readOnlyHint: true } : undefined })),
		entries: [], sentMessages: [], sentUserMessages: [], toolCalls: [], setActiveToolCalls: [],
		registerFlag(name, config) { this.flags.set(name, config); },
		getFlag(name) { return name === "plan" ? flagPlan : undefined; },
		registerTool(tool) { this.tools.set(tool.name, tool); this.allTools.push({ ...tool, exposure: "direct" }); active.push(tool.name); },
		registerCommand(name, command) { this.commands.set(name, command); },
		registerShortcut(key, shortcut) { this.shortcuts.push({ key, shortcut }); },
		on(name, handler) { const handlers = this.handlers.get(name) ?? []; handlers.push(handler); this.handlers.set(name, handlers); },
		getActiveTools() { return [...active]; },
		getAllTools() { return this.allTools; },
		setActiveTools(names) { active = [...new Set(names)]; this.setActiveToolCalls.push([...active]); },
		appendEntry(customType, data) { const entry = clone({ type: "custom", customType, data }); this.entries.push(entry); this.ctx.branch.push(entry); },
		sendMessage(message, options) { this.sentMessages.push({ message, options }); },
		sendUserMessage(content, options) { this.sentUserMessages.push({ content, options }); },
		async emit(name, event = {}) { let result; for (const handler of this.handlers.get(name) ?? []) result = await handler(event, this.ctx) ?? result; return result; },
		async start(reason = "startup") { await this.emit("session_start", { reason }); },
		async command(name, args = "") { return this.commands.get(name).handler(args, this.ctx); },
		async write(todos, toolCallId = "todo-call") { return this.tools.get("todo_write").execute(toolCallId, { todos }, undefined, undefined, this.ctx); },
		async context(messages = []) { return (await this.emit("context", { messages })).messages; },
		async settle(overrides = {}) { return this.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed", context: { pendingMessages: [], canContinue: false }, ...overrides }); },
		get state() { return this.entries.at(-1)?.data; },
		get activeTools() { return [...active]; },
	};
	// Model the nested-call contract: tool_call fires, but nested results do not
	// become session messages. Tool mutations must persist themselves.
	ctx.executeTool = async (name, input) => {
		const event = { toolName: name, input, toolCallId: `outer/${pi.toolCalls.length}`, parentToolCallId: "outer" };
		pi.toolCalls.push(event);
		const block = await pi.emit("tool_call", event);
		if (block?.block) throw new Error(block.reason);
		if (name === "todo_write") return pi.write(input.todos, event.toolCallId);
		return { content: [], details: undefined };
	};
	planModeExtension(pi);
	return pi;
}
const item = (text, status = "pending", extras = {}) => ({ text, status, ...extras });
const persisted = (data) => ({ type: "custom", customType: "plan-mode", data });
const todoResult = (details) => ({ type: "message", message: { role: "toolResult", toolName: "todo_write", details } });
const snapshot = (runs, ownerSessionId = "session-a") => ({ version: 1, ownerSessionId, runs });
const run = (id, status, taskId) => ({ id, status, taskId, task: "Worker task" });

// Identity and status rules.
test("normalization handles all six statuses, reasons, and legacy completion without reviving cancelled items", () => {
	const todos = normalizeTodoItems([
		...TODO_STATUSES.map((status) => item(` ${status}   task `, status, { reason: " reason   here " })),
		{ text: "legacy", completed: true },
		{ text: "   " },
		{ text: "invalid status", status: "unknown" },
	]);
	assert.deepEqual(todos.slice(0, 6).map((todo) => todo.status), TODO_STATUSES);
	assert.equal(todos[0].reason, "reason here");
	assert.equal(todos[6].status, "completed");
	assert.equal(todos[7].status, "pending");
	assert.deepEqual(todos.map((todo) => todo.step), [1, 2, 3, 4, 5, 6, 7, 8]);
	assert.equal(isTodoCompleted(todos[5]), false);
	assert.equal(isTodoTerminal(todos[5]), true);
	assert.equal(normalizeTodoItems([{ text: "cancel", status: "cancelled", completed: true }])[0].status, "cancelled");
});
test("IDs match normalized text across reordering and reserve explicit IDs before matching", () => {
	const old = normalizeTodoItems([item(" first ", "pending", { id: "a" }), item("same", "pending", { id: "b" }), item("same", "pending", { id: "c" })]);
	assert.deepEqual(normalizeTodoItems([item("same"), item("first"), item("same")], old).map((todo) => todo.id), ["b", "a", "c"]);
	const changed = normalizeTodoItems([item("first"), item("renamed", "completed", { id: "a" }), item("same")], old);
	assert.notEqual(changed[0].id, "a");
	assert.equal(changed[1].id, "a");
	assert.equal(changed[2].id, "b");
	assert.equal(new Set(changed.map((todo) => todo.id)).size, 3);
});
test("duplicate input IDs fail; persisted duplicates and generated-ID collisions are repaired", () => {
	assert.throws(() => validateTodoIds([item("a", "pending", { id: " x " }), item("b", "pending", { id: "x" })]), /Duplicate/);
	assert.throws(() => validateTodoIds([item("a", "pending", { id: " " })]), /empty/);
	const todos = normalizeTodoItems([item("a"), item("b", "pending", { id: "todo-1" }), item("c", "pending", { id: "todo-1" })]);
	assert.equal(todos[1].id, "todo-1");
	assert.equal(new Set(todos.map((todo) => todo.id)).size, 3);
});

test("registration uses the final actionable boundary, not agent_end or a completion input hook", () => {
	const pi = install();
	assert.equal(pi.flags.get("plan").default, false);
	assert.equal(pi.commands.has("todos"), true);
	assert.equal(pi.shortcuts.length, 1);
	for (const event of ["tool_call", "user_bash", "context", "before_agent_start", "agent_before_settle", "session_start", "session_tree", "session_shutdown"]) assert.equal(pi.handlers.has(event), true, event);
	assert.equal(pi.handlers.has("agent_end"), false);
	assert.equal(pi.handlers.has("input"), false);
	assert.match(pi.tools.get("todo_write").promptGuidelines.join("\n"), /background completion.*review/i);
});
test("ordinary todo_write is visible and every mutation is durable before any tool result", async () => {
	const pi = install();
	await pi.start();
	const result = await pi.write([item(" first   task ", "in_progress"), item("finished", "completed"), item("no longer needed", "cancelled", { reason: "superseded" })]);
	assert.equal(result.details.completed, 1);
	assert.equal(result.details.cancelled, 1);
	assert.equal(result.details.total, 3);
	assert.deepEqual(pi.state.todos, result.details.todos);
	assert.equal(pi.ctx.branch.some((entry) => entry.type === "message"), false);
	assert.equal(pi.ctx.statuses.get("plan-mode"), "📋 1/3 · 1 cancelled");
	assert.equal(pi.ctx.render().length, 3);
	assert.match(pi.ctx.render().join("\n"), /superseded/);
	await pi.command("todos");
	assert.match(pi.ctx.notifications.at(-1).message, /Checklist:/);
	assert.match((await pi.context()).at(-1).content, /first task/);
});
test("full-list semantics preserve matching IDs, permit explicit rename, and reject duplicate mutation atomically", async () => {
	const pi = install();
	const first = (await pi.write([item("a"), item("b", "completed")])).details.todos;
	const result = await pi.write([item("renamed", "waiting", { id: first[0].id, reason: "worker running" }), item("b", "completed")]);
	assert.deepEqual(result.details.todos.map((todo) => todo.id), first.map((todo) => todo.id));
	const state = clone(pi.state);
	await assert.rejects(pi.write([item("x", "pending", { id: "same" }), item("y", "pending", { id: "same" })]), /Duplicate/);
	assert.deepEqual(pi.state, state);
	await pi.write([item("b", "completed")]);
	assert.equal(pi.state.todos.length, 1, "omitting a task intentionally removes it");
	assert.equal(pi.state.todos[0].id, first[1].id);
});
test("new IDs do not alias removed work or independently created sibling-branch tasks", async () => {
	const pi = install();
	const firstId = (await pi.write([item("a")])).details.todos[0].id;
	await pi.command("todos", "clear");
	const newId = (await pi.write([item("a")])).details.todos[0].id;
	assert.notEqual(newId, firstId);
	pi.ctx.branch = [];
	await pi.emit("session_tree");
	assert.notEqual((await pi.write([item("a")])).details.todos[0].id, newId);
});
test("nested executeTool updates survive reload without transcript results; late v2 results cannot overwrite newer state", async () => {
	const pi = install();
	await pi.start();
	const first = await pi.ctx.executeTool("todo_write", { todos: [item("nested", "in_progress")] });
	const latest = await pi.ctx.executeTool("todo_write", { todos: [item("nested", "completed")] });
	assert.equal(pi.ctx.branch.some((entry) => entry.type === "message"), false);
	pi.ctx.branch.push(todoResult(first.details)); // Outer/parallel results can arrive later.
	await pi.emit("session_shutdown");
	const reloaded = install({ ctx: makeCtx({ branch: pi.ctx.branch }) });
	await reloaded.start("reload");
	assert.deepEqual(reloaded.state.todos, latest.details.todos);
	assert.equal(reloaded.state.todos[0].status, "completed");
});
test("legacy tool details and legacy plan states migrate with stable unique IDs on the active branch", async () => {
	const branch = [persisted({ enabled: false, todos: [{ text: "legacy", completed: true }] }), todoResult({ todos: [{ text: "legacy", completed: true }, item("next")] })];
	const pi = install({ ctx: makeCtx({ branch }) });
	await pi.start("resume");
	assert.equal(pi.state.todos[0].status, "completed");
	const saved = clone(pi.state.todos);
	await pi.emit("session_start", { reason: "reload" });
	assert.deepEqual(pi.state.todos, saved);
});

// Permission guard: no shell parsing, no permissive unknown/custom tools.
test("planning exposes only registered safe tools and restores the exact previous loadout", async () => {
	const pi = install({ activeTools: ["custom_tool", "bash"] });
	await pi.start();
	const original = pi.activeTools;
	await pi.command("plan");
	assert.deepEqual(pi.activeTools, ["read", "grep", "find", "ls", "questionnaire", "subagent_control", "todo_write"]);
	assert.match(pi.ctx.notifications.at(-1).message, /does not undo or stop already-running/);
	assert.equal(pi.toolCalls.length, 0, "entering plan mode does not cancel jobs");
	await pi.command("plan");
	assert.deepEqual(pi.activeTools, original);
	assert.equal(pi.state.toolsBeforePlanMode, null);
});
test("all bash commands, shell bypasses, and user-bash are blocked while planning", async () => {
	const pi = install();
	await pi.command("plan");
	for (const command of ["ls", "echo ok; python -c 'open(\"x\",\"w\")'", "find . -delete", "find . -exec sh -c 'evil' \\;", "echo $(curl -X POST https://example.com)", "git status; git push", "awk 'BEGIN {system(\"evil\")}'", "sed -n 'w output' input", "curl --output x https://example.com", "ls\nnode -e 'process.exit()'"]) {
		assert.equal((await pi.emit("tool_call", { toolName: "bash", input: { command } })).block, true, command);
	}
	assert.equal((await pi.emit("user_bash", { command: "ls" })).result.exitCode, 1);
	await pi.command("plan");
	assert.equal(await pi.emit("tool_call", { toolName: "bash", input: { command: "anything" } }), undefined);
	assert.equal(await pi.emit("user_bash", { command: "anything" }), undefined);
});
test("tool_call blocks inactive, unknown, deferred, annotated, orchestration and nested write capabilities", async () => {
	const pi = install();
	pi.allTools.push({ name: "deferred_writer", exposure: "codemode" });
	await pi.command("plan");
	for (const name of ["edit", "write", "bash", "subagent", "schedule", "custom_tool", "unknown", "safe_claim", "deferred_writer", "codemode"]) {
		await assert.rejects(pi.ctx.executeTool(name, { command: "ls" }), /Plan mode/, name);
	}
	for (const name of ["read", "grep", "find", "ls", "questionnaire"]) assert.equal(await pi.emit("tool_call", { toolName: name, input: {} }), undefined);
	await pi.ctx.executeTool("todo_write", { todos: [item("allowed", "pending")] });
	assert.equal(pi.state.todos[0].text, "allowed");
	pi.allTools = pi.allTools.filter((tool) => tool.name !== "read");
	assert.equal((await pi.emit("tool_call", { toolName: "read", input: {} })).block, true, "safe names still must be registered");
});
test("only list/status/stop subagent control operations are allowed, including nested calls", async () => {
	const pi = install();
	await pi.command("plan");
	for (const action of ["list", "status", "stop", undefined]) await pi.ctx.executeTool("subagent_control", { action });
	for (const action of ["start", "send", "schedule", "schedule_list", "schedule_stop", "restart", "LIST"]) await assert.rejects(pi.ctx.executeTool("subagent_control", { action }), /blocked/);
});

// Reversible loadouts and branch-local state.
test("toggling plan mode never clears completed or active tasks", async () => {
	const pi = install();
	const todos = (await pi.write([item("done", "completed"), item("work", "blocked", { reason: "needs input" })])).details.todos;
	await pi.command("plan");
	assert.deepEqual(pi.state.todos, todos);
	assert.match(pi.ctx.statuses.get("plan-mode"), /⏸ plan.*1\/2/);
	await pi.command("plan");
	assert.deepEqual(pi.state.todos, todos);
});
test("tree navigation restores outgoing tools for an ordinary/empty branch and target snapshot for a planned branch", async () => {
	const pi = install({ activeTools: ["bash", "custom_tool"] });
	await pi.start();
	const original = pi.activeTools;
	await pi.write([item("branch a", "completed")]);
	await pi.command("plan");
	const plannedBranch = clone(pi.ctx.branch);
	pi.ctx.branch = [];
	await pi.emit("session_tree");
	assert.deepEqual(pi.activeTools, original);
	assert.equal(pi.state.enabled, false);
	assert.deepEqual(pi.state.todos, []);
	pi.setActiveTools(["read"]);
	pi.ctx.branch = plannedBranch;
	await pi.emit("session_tree");
	assert.equal(pi.activeTools.includes("bash"), false);
	assert.equal(pi.state.todos[0].text, "branch a");
	await pi.command("plan");
	assert.deepEqual(pi.activeTools, original, "must not replace persisted snapshot with current read-only tools");
});
test("reload preserves enabled mode and its original tools, and disabled state explicitly clears old snapshots", async () => {
	const pi = install({ activeTools: ["bash", "custom_tool"] });
	await pi.start();
	const original = pi.activeTools;
	await pi.command("plan");
	await pi.emit("session_shutdown");
	assert.deepEqual(pi.activeTools, original);
	const reload = install({ ctx: makeCtx({ branch: pi.ctx.branch }), activeTools: ["read"] });
	await reload.start("reload");
	assert.equal(reload.state.enabled, true);
	await reload.command("plan");
	assert.deepEqual(reload.activeTools, original);
	assert.equal(reload.state.toolsBeforePlanMode, null);
	const disabled = install({ ctx: makeCtx({ branch: reload.ctx.branch }), activeTools: ["write"], flagPlan: true });
	await disabled.start("reload");
	assert.equal(disabled.state.enabled, false);
	assert.deepEqual(disabled.activeTools, original);
	assert.equal(disabled.state.toolsBeforePlanMode, null);
});
test("missing, undefined and null snapshots clear rather than retain a stale earlier snapshot", async () => {
	for (const clear of [{}, { toolsBeforePlanMode: undefined, normalTools: undefined }, { toolsBeforePlanMode: null, normalTools: null }]) {
		for (const enabled of [false, true]) {
			const pi = install({ activeTools: ["read"], ctx: makeCtx({ branch: [
				persisted({ enabled: true, toolsBeforePlanMode: ["stale_write"], normalTools: ["stale_write"] }),
				persisted({ enabled, ...clear }),
			] }) });
			const original = pi.activeTools;
			await pi.start("resume");
			if (!enabled) await pi.command("plan");
			await pi.command("plan", "off");
			assert.deepEqual(pi.activeTools, original);
			assert.equal(pi.activeTools.includes("stale_write"), false);
			assert.equal(pi.state.toolsBeforePlanMode, null);
		}
		const pi = install({ activeTools: ["read"], ctx: makeCtx({ branch: [
			persisted({ enabled: true, toolsBeforePlanMode: ["stale_write"] }),
			persisted({ enabled: false, normalTools: ["stale_write"] }),
			persisted({ enabled: false, ...clear }),
		] }) });
		const original = pi.activeTools;
		await pi.start("resume");
		assert.deepEqual(pi.activeTools, original, "later full snapshots also clear cached plan-exit tools");
	}
});
test("an explicitly empty saved loadout remains empty after plan exit and reload", async () => {
	const pi = install();
	pi.setActiveTools([]);
	await pi.start();
	await pi.command("plan");
	await pi.command("plan", "off");
	assert.deepEqual(pi.activeTools, []);
	await pi.start("reload");
	assert.deepEqual(pi.activeTools, []);
	assert.deepEqual(pi.state.normalTools, []);
});
test("session replacement does not carry the previous session's restricted tools or todos", async () => {
	const pi = install();
	await pi.start();
	const original = pi.activeTools;
	await pi.write([item("session a", "in_progress")]);
	await pi.command("plan");
	pi.ctx.branch = [];
	pi.ctx.sessionId = "session-b";
	await pi.start("new");
	assert.deepEqual(pi.activeTools, original);
	assert.deepEqual(pi.state.todos, []);
	assert.equal(pi.state.enabled, false);
});
test("--plan initializes only new state, never overrides persisted false or an existing session", async () => {
	const pi = install({ flagPlan: true });
	await pi.start();
	assert.equal(pi.state.enabled, true);
	await pi.command("plan");
	await pi.start("reload");
	assert.equal(pi.state.enabled, false);
	pi.ctx.branch = [];
	await pi.emit("session_tree");
	assert.equal(pi.state.enabled, false);
	const existing = install({ flagPlan: true, ctx: makeCtx({ branch: [{ type: "message", message: { role: "user", content: "hello" } }] }) });
	await existing.start();
	assert.equal(existing.state.enabled, false);
	const resumed = install({ flagPlan: true });
	await resumed.start("resume");
	assert.equal(resumed.state.enabled, false);
});

// Context and final approval lifecycle.
test("every context build removes only owned custom types and inserts exactly one fresh snapshot, even in ordinary mode", async () => {
	const pi = install();
	const userMessages = [
		{ role: "user", content: "Please discuss [PLAN MODE ACTIVE] and [EXECUTING PLAN]" },
		{ role: "user", content: [{ type: "text", text: "[PLAN MODE ACTIVE]" }, { type: "image", data: "image" }] },
		{ role: "custom", customType: "another-extension", content: "[EXECUTING PLAN]" },
	];
	let messages = await pi.context([...userMessages, { role: "custom", customType: "plan-mode-context", content: "stale" }, { role: "custom", customType: "plan-execution-context", content: "old execution" }]);
	assert.deepEqual(messages.slice(0, 3), userMessages);
	assert.equal(messages.length, 4);
	await pi.write([item("latest", "completed")]);
	messages = await pi.context(messages);
	assert.equal(messages.length, 4);
	assert.match(messages.at(-1).content, /latest/);
	await pi.command("plan");
	messages = await pi.context(messages);
	assert.equal(messages.length, 4);
	assert.match(messages.at(-1).content, /\[PLAN MODE ACTIVE\]/);
	await pi.command("plan");
	await pi.write([]);
	messages = await pi.context(messages);
	assert.equal(messages.length, 4);
	assert.match(messages.at(-1).content, /No todos/);
	assert.doesNotMatch(messages.at(-1).content, /latest|\[PLAN MODE ACTIVE\]/);
	assert.deepEqual(messages.slice(0, 3), userMessages);
});
test("settlement is synchronous and nonblocking; only /plan execute approves one follow-up and retains finished tasks", async () => {
	for (const hasUI of [true, false]) {
		const pi = install({ ctx: makeCtx({ hasUI }) });
		await pi.start();
		const original = pi.activeTools;
		await pi.command("plan");
		await pi.write([item("done", "completed"), item("obsolete", "cancelled"), item("work", "blocked", { reason: "review first" })]);
		const planned = clone(pi.state);
		const restricted = pi.activeTools;
		await pi.emit("before_agent_start", { messageType: "user" });
		await pi.emit("agent_end", { messages: [] });
		await pi.emit("agent_end", { messages: [] }); // Automatic retry can emit this more than once.
		const event = { entries: [], continue: false, outcome: "completed", context: { pendingMessages: [], canContinue: false } };
		const settle = pi.handlers.get("agent_before_settle")[0];
		assert.equal(settle(event, pi.ctx), undefined, "not even a pending Promise/dialog may hold settlement");
		assert.deepEqual(event.entries, []);
		assert.equal(event.continue, false);
		assert.deepEqual(pi.state, planned);
		assert.deepEqual(pi.activeTools, restricted);
		assert.equal(pi.sentMessages.length, 0);
		assert.equal(pi.ctx.notifications.filter(({ message }) => message.startsWith("Plan ready.")).length, hasUI ? 1 : 0);
		assert.equal(await pi.settle(), undefined);
		await pi.command("plan", "execute");
		assert.equal(pi.state.executing, true);
		assert.equal(pi.state.enabled, false);
		assert.deepEqual(pi.activeTools, original);
		assert.equal(pi.state.toolsBeforePlanMode, null);
		assert.equal(pi.sentMessages.length, 1);
		assert.deepEqual(pi.sentMessages[0].options, { deliverAs: "followUp", triggerTurn: true });
		assert.equal(pi.sentMessages[0].message.customType, "plan-mode-execute");
		assert.equal(pi.sentMessages[0].message.display, true);
		assert.match(pi.sentMessages[0].message.content, /approved plan.*waiting\/blocked/s);
		for (const text of ["done", "obsolete", "work", "review first"]) assert.ok(pi.sentMessages[0].message.content.includes(text));
		await pi.command("plan", "execute");
		assert.match(pi.ctx.notifications.at(-1).message, /not enabled/);
		await pi.write([item("done", "completed"), item("obsolete", "cancelled"), item("work", "completed")]);
		await pi.settle();
		assert.equal(pi.state.executing, false);
		assert.equal(pi.state.todos.length, 3);
		assert.equal(pi.ctx.render().length, 3);
		assert.equal(pi.sentMessages.length, 1, "no repeated approval or automatic completion loop");
		assert.equal(pi.ctx.selections.length, 0);
		assert.equal(pi.ctx.editors.length, 0);
	}
});
test("background wake, abort/error, headless, empty, and fully terminal lists do not announce readiness or change permissions", async () => {
	for (const options of [
		{ messageType: "custom" }, { outcome: "aborted" }, { outcome: "error" }, { hasUI: false },
		{ todos: [] }, { todos: [item("done", "completed"), item("cancel", "cancelled")] },
	]) {
		const pi = install({ ctx: makeCtx({ hasUI: options.hasUI ?? true }) });
		await pi.command("plan");
		await pi.write(options.todos ?? [item("work")]);
		await pi.emit("before_agent_start", { messageType: options.messageType ?? "user" });
		const state = clone(pi.state);
		const calls = pi.setActiveToolCalls.length;
		const notifications = pi.ctx.notifications.length;
		assert.equal(await pi.settle({ outcome: options.outcome ?? "completed" }), undefined);
		await pi.settle(); // A later callback must not revive readiness after abort/error.
		assert.equal(pi.ctx.notifications.length, notifications);
		assert.equal(pi.setActiveToolCalls.length, calls);
		assert.deepEqual(pi.state, state);
		assert.equal(pi.ctx.selections.length, 0);
		assert.equal(pi.sentMessages.length, 0);
		assert.equal(pi.state.executing, false);
	}
});
test("queued continuations delay the readiness notice; refinement is ordinary user input and never auto-approves", async () => {
	const pi = install();
	await pi.command("plan");
	await pi.write([item("work")]);
	const notices = () => pi.ctx.notifications.filter(({ message }) => message.startsWith("Plan ready."));
	await pi.emit("before_agent_start", { messageType: "user" });
	await pi.settle({ continue: true });
	await pi.settle({ context: { pendingMessages: [{ role: "custom", content: "queued work" }], canContinue: true } });
	assert.equal(notices().length, 0);
	await pi.settle();
	await pi.settle();
	assert.equal(notices().length, 1);
	await pi.emit("before_agent_start", { messageType: "user", prompt: "make it smaller" });
	await pi.write([item("smaller work")]);
	await pi.settle();
	await pi.settle();
	assert.equal(notices().length, 2);
	assert.equal(pi.ctx.selections.length, 0);
	assert.equal(pi.ctx.editors.length, 0);
	assert.equal(pi.state.enabled, true);
	assert.equal(pi.state.executing, false);
	assert.equal(pi.sentMessages.length, 0);
	assert.equal(pi.sentUserMessages.length, 0);
});
test("abort and branch changes leave no asynchronous approval that can later change permissions", async () => {
	let respond;
	const pi = install({ ctx: makeCtx({ selectValue: () => new Promise((resolve) => { respond = resolve; }) }) });
	await pi.start();
	await pi.command("plan");
	await pi.write([item("old work")]);
	await pi.emit("before_agent_start", { messageType: "user" });
	const settling = pi.settle({ outcome: "aborted" });
	pi.ctx.branch = [persisted({ enabled: true, todos: [item("new work")], toolsBeforePlanMode: ["read"] })];
	await pi.emit("session_tree");
	const state = clone(pi.state);
	const calls = pi.setActiveToolCalls.length;
	respond?.("Execute the plan (track progress)");
	assert.equal(await settling, undefined);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(respond, undefined, "no asynchronous approval was requested");
	assert.equal(pi.setActiveToolCalls.length, calls);
	assert.deepEqual(pi.state, state);
	assert.equal(pi.state.enabled, true);
	assert.equal(pi.state.executing, false);
	assert.equal(pi.sentMessages.length, 0);
});
test("/plan execute rejects invalid states and arguments without touching permissions or the checklist", async () => {
	for (const { enabled, todos, action, message } of [
		{ enabled: false, todos: [item("work")], action: "execute", message: /not enabled/ },
		{ enabled: true, todos: [], action: "execute", message: /No unfinished tasks/ },
		{ enabled: true, todos: [item("done", "completed"), item("cancel", "cancelled")], action: "execute", message: /No unfinished tasks/ },
		{ enabled: true, todos: [item("work")], action: "execute now", message: /Usage:/ },
	]) {
		const pi = install();
		await pi.start();
		if (enabled) await pi.command("plan");
		await pi.write(todos);
		const state = clone(pi.state);
		const calls = pi.setActiveToolCalls.length;
		await pi.command("plan", action);
		assert.match(pi.ctx.notifications.at(-1).message, message);
		assert.deepEqual(pi.state, state);
		assert.equal(pi.setActiveToolCalls.length, calls);
		assert.equal(pi.sentMessages.length, 0);
	}
});
test("/plan off is idempotent, restores tools, and never starts execution", async () => {
	const pi = install();
	await pi.start();
	const original = pi.activeTools;
	await pi.write([item("retained")]);
	await pi.command("plan");
	await pi.command("plan", "off");
	await pi.command("plan", "off");
	assert.deepEqual(pi.activeTools, original);
	assert.equal(pi.state.enabled, false);
	assert.equal(pi.state.executing, false);
	assert.equal(pi.state.todos[0].text, "retained");
	assert.equal(pi.state.toolsBeforePlanMode, null);
	assert.equal(pi.sentMessages.length, 0);
});
test("explicit clearing is durable and no automatic prose/DONE extraction can resurrect it", async () => {
	const pi = install();
	await pi.command("plan");
	await pi.write([item("done", "completed")]);
	await pi.command("todos", "clear");
	await pi.emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "Plan:\n1. Do not resurrect me [DONE:1]" }] }] });
	assert.deepEqual(pi.state.todos, []);
	assert.equal(pi.state.enabled, true);
	assert.equal(pi.state.executing, false);
	await pi.start("reload");
	assert.deepEqual(pi.state.todos, []);
	assert.equal(pi.ctx.widgets.get("plan-todos"), undefined);
});

// Public bus contract: observation, scope, and disposal.
test("context-request responds only for its session and only returns a uniquely in-progress task ID", async () => {
	const pi = install();
	let response;
	const request = (ownerSessionId = "session-a") => { response = undefined; pi.events.emit("pi-plan:context-request", { ownerSessionId, respond: (value) => { response = value; } }); return response; };
	assert.equal(request(), undefined, "no subscription before session start");
	await pi.start();
	assert.deepEqual(request(), { readOnly: false });
	await pi.write([item("one", "in_progress", { id: "task-a" }), item("wait", "waiting", { id: "task-b" })]);
	assert.deepEqual(request(), { readOnly: false, taskId: "task-a" });
	assert.equal(request("foreign-session"), undefined);
	await pi.command("plan");
	assert.deepEqual(request(), { readOnly: true, taskId: "task-a" });
	await pi.write([item("one", "in_progress", { id: "task-a" }), item("two", "in_progress", { id: "task-b" })]);
	assert.deepEqual(request(), { readOnly: true });
	await pi.write([]);
	assert.deepEqual(request(), { readOnly: true });
});
test("session start/tree request snapshots; linked badges never mark completion, including failed and aborted workers", async () => {
	const bus = makeBus();
	const requests = [];
	bus.on("pi-subagent:snapshot-request", (request) => { requests.push(request.ownerSessionId); request.respond(snapshot([run("job-1", "running", "a"), run("orphan", "running")])); });
	const pi = install({ bus, ctx: makeCtx({ branch: [persisted({ enabled: false, todos: [item("main task", "in_progress", { id: "a" })] })] }) });
	await pi.start("resume");
	assert.deepEqual(requests, ["session-a"]);
	assert.match(pi.ctx.render().join("\n"), /job-1: running/);
	assert.match(pi.ctx.render().join("\n"), /Unlinked jobs: 1 running/);
	const entriesBefore = pi.entries.length;
	for (const status of ["completed", "failed", "aborted", "queued"]) {
		bus.emit("pi-subagent:state", snapshot([run("job-1", status, "a")]));
		assert.equal(pi.state.todos[0].status, "in_progress");
		assert.match(pi.ctx.render().join("\n"), new RegExp(status === "completed" ? "finished; review" : status));
	}
	assert.equal(pi.entries.length, entriesBefore, "observations do not mutate durable task state");
	assert.equal(pi.sentMessages.length, 0);
	assert.equal(pi.sentUserMessages.length, 0);
	await pi.emit("session_tree");
	assert.deepEqual(requests, ["session-a", "session-a"]);
	assert.equal(bus.count("pi-subagent:state"), 1);
	assert.equal(bus.count("pi-plan:context-request"), 1);
});
test("foreign snapshots, duplicate snapshots, stale callbacks, and removed task links cannot leak or falsely complete tasks", async () => {
	const bus = makeBus();
	const callbacks = [];
	bus.on("pi-subagent:snapshot-request", ({ respond }) => callbacks.push(respond));
	const pi = install({ bus });
	await pi.start();
	await pi.write([item("task", "in_progress", { id: "a" })]);
	const event = snapshot([run("worker", "completed", "a")]);
	bus.emit("pi-subagent:state", event);
	bus.emit("pi-subagent:state", event);
	assert.equal(pi.ctx.render().join("\n").match(/worker:/g).length, 1);
	bus.emit("pi-subagent:state", snapshot([run("foreign", "failed", "a")], "other"));
	assert.doesNotMatch(pi.ctx.render().join("\n"), /foreign/);
	await pi.write([item("replacement", "pending", { id: "b" })]);
	assert.doesNotMatch(pi.ctx.render()[0], /worker/);
	assert.match(pi.ctx.render().join("\n"), /Unlinked jobs: 1 finished/);
	pi.ctx.branch = [];
	pi.ctx.sessionId = "session-b";
	await pi.start("new");
	callbacks[0](event);
	bus.emit("pi-subagent:state", event);
	assert.equal(pi.ctx.render().length, 0);
	assert.deepEqual(pi.state.todos, []);
	let response;
	bus.emit("pi-plan:context-request", { ownerSessionId: "session-a", respond: (value) => { response = value; } });
	assert.equal(response, undefined);
	callbacks[1](snapshot([run("current", "running")], "session-b"));
	assert.match(pi.ctx.render().join("\n"), /1 running/);
});
test("reload/shutdown subscriptions are idempotent and stale snapshot callbacks are inert", async () => {
	const bus = makeBus();
	let oldRespond;
	bus.on("pi-subagent:snapshot-request", ({ respond }) => { oldRespond ??= respond; });
	const pi = install({ bus });
	await pi.start();
	await pi.start("reload");
	assert.equal(bus.count("pi-subagent:state"), 1);
	await pi.emit("session_shutdown");
	await pi.emit("session_shutdown");
	assert.equal(bus.count("pi-subagent:state"), 0);
	assert.equal(bus.count("pi-plan:context-request"), 0);
	const reloaded = install({ bus, ctx: makeCtx({ branch: pi.ctx.branch }) });
	await reloaded.start("reload");
	oldRespond(snapshot([run("stale", "running")]));
	assert.equal(reloaded.ctx.render().length, 0);
	assert.equal(pi.ctx.widgets.get("plan-todos"), undefined);
	assert.equal(bus.count("pi-subagent:state"), 1);
});
test("malformed integration payloads are ignored without throwing", () => {
	for (const value of [null, undefined, {}, { version: 2, ownerSessionId: "session-a", runs: [] }]) assert.equal(readSubagentSnapshot(value, "session-a"), undefined);
	assert.deepEqual(readSubagentSnapshot(snapshot([null, {}, run("a", "running"), run("a", "failed"), run("bad", "invalid")]), "session-a").runs, [run("a", "running")].map(({ taskId, ...rest }) => rest));
});
test("widget recomputes theme styles and truncates safely at narrow terminal widths", async () => {
	const pi = install();
	await pi.write([item("wide 界 🌟 checklist task", "completed")]);
	const component = pi.ctx.widgets.get("plan-todos")({}, pi.ctx.ui.theme);
	assert.ok(component.render(10).every((line) => visibleWidth(line) <= 10));
	pi.ctx.ui.theme.fg = (_color, text) => `NEW:${text}`;
	component.invalidate();
	assert.match(component.render(100)[0], /NEW:/);
});
test("RPC mode publishes string-array widgets instead of unsupported component factories", async () => {
	const ctx = makeCtx();
	ctx.mode = "rpc";
	const pi = install({ ctx });
	await pi.write([item("RPC visible", "waiting", { reason: "worker running" })]);
	const lines = ctx.widgets.get("plan-todos");
	assert.ok(Array.isArray(lines));
	assert.match(lines.join("\n"), /RPC visible.*worker running/);
});

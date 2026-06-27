import assert from "node:assert/strict";
import test from "node:test";

import planModeExtension from "../extensions/plan-tracker/index.ts";
import {
	cleanStepText,
	extractDoneSteps,
	extractTodoItems,
	isSafeCommand,
	isTodoCompleted,
	markCompletedSteps,
	normalizeTodoItems,
} from "../extensions/plan-tracker/utils.ts";

const theme = {
	fg: (_name, value) => String(value),
	bold: (value) => String(value),
	strikethrough: (value) => `~~${value}~~`,
};

function makeCtx({ branch = [], selectValue, editorValue = "" } = {}) {
	const statuses = new Map();
	const widgets = new Map();
	const notifications = [];

	return {
		hasUI: true,
		statuses,
		widgets,
		notifications,
		sessionManager: { getBranch: () => branch },
		ui: {
			theme,
			setStatus: (name, value) => statuses.set(name, value),
			setWidget: (name, value) => widgets.set(name, value),
			notify: (message, type) => notifications.push({ message, type }),
			select: async () => selectValue,
			editor: async () => editorValue,
		},
	};
}

function makePi({ activeTools: initialActiveTools = ["read", "bash", "edit", "write", "custom_tool"], flagPlan = false } = {}) {
	let activeTools = initialActiveTools.slice();

	const pi = {
		registeredFlags: new Map(),
		registeredTools: [],
		commands: new Map(),
		shortcuts: [],
		handlers: new Map(),
		entries: [],
		sentMessages: [],
		sentUserMessages: [],
		setActiveToolCalls: [],

		registerFlag(name, config) {
			this.registeredFlags.set(name, config);
		},
		getFlag(name) {
			return name === "plan" ? flagPlan : undefined;
		},
		registerTool(tool) {
			this.registeredTools.push(tool);
		},
		registerCommand(name, command) {
			this.commands.set(name, command);
		},
		registerShortcut(key, shortcut) {
			this.shortcuts.push({ key, shortcut });
		},
		on(name, handler) {
			const handlers = this.handlers.get(name) ?? [];
			handlers.push(handler);
			this.handlers.set(name, handlers);
		},
		getActiveTools() {
			return activeTools.slice();
		},
		setActiveTools(nextTools) {
			activeTools = nextTools.slice();
			this.setActiveToolCalls.push(nextTools.slice());
		},
		appendEntry(customType, data) {
			this.entries.push({ type: "custom", customType, data });
		},
		sendMessage(message, options) {
			this.sentMessages.push({ message, options });
		},
		sendUserMessage(content, options) {
			this.sentUserMessages.push({ content, options });
		},
		get activeTools() {
			return activeTools.slice();
		},
	};

	return pi;
}

function installExtension(options) {
	const pi = makePi(options);
	planModeExtension(pi);
	return pi;
}

test("safe command allowlist blocks obvious writes", () => {
	for (const command of ["ls -la", " rg TODO extensions", "git status --short", "git ls-files", "npm audit", "sed -n '1,5p' file"]) {
		assert.equal(isSafeCommand(command), true, command);
	}

	for (const command of ["rm -rf .", "echo hi > out.txt", "cat a >> b", "git commit -m test", "npm ci", "sudo ls", "vim file", "ls; rm file"]) {
		assert.equal(isSafeCommand(command), false, command);
	}
});

test("todo utilities normalize, clean, and mark completion", () => {
	assert.deepEqual(
		normalizeTodoItems([
			{ step: 99, text: "  first   item  ", status: "pending" },
			{ step: 100, text: "   ", status: "completed" },
			{ step: 101, text: "legacy done", completed: true },
		]),
		[
			{ step: 1, text: "first item", status: "pending" },
			{ step: 2, text: "legacy done", status: "completed" },
		],
	);

	assert.equal(cleanStepText("Write the tiny test"), "Tiny test");
	assert.equal(isTodoCompleted({ step: 1, text: "x", status: "pending", completed: true }), true);

	const items = [
		{ step: 1, text: "a", status: "pending" },
		{ step: 2, text: "b", status: "pending" },
	];
	assert.deepEqual(extractDoneSteps("ok [DONE:1] and [done:2]"), [1, 2]);
	assert.equal(markCompletedSteps("[DONE:2]", items), 1);
	assert.equal(items[1].status, "completed");
});

test("extractTodoItems parses markdown plan lists", () => {
	assert.deepEqual(extractTodoItems("No plan here"), []);
	assert.deepEqual(
		extractTodoItems(`Intro

Plan:
1. Read the **source** files
2) **Update** utils parser
3. Run tests
4. \`/plan\`
5. /reload
`),
		[
			{ step: 1, text: "Source files", status: "pending" },
			{ step: 2, text: "Utils parser", status: "pending" },
			{ step: 3, text: "Tests", status: "pending" },
		],
	);
});

test("extension registers commands, shortcut, tool, and lifecycle handlers", () => {
	const pi = installExtension();

	assert.equal(pi.registeredFlags.get("plan")?.default, false);
	assert.equal(pi.registeredTools.find((tool) => tool.name === "todo_write")?.label, "TodoWrite");
	assert.equal(pi.commands.has("plan"), true);
	assert.equal(pi.commands.has("todos"), true);
	assert.equal(pi.shortcuts.length, 1);

	for (const eventName of ["tool_call", "context", "before_agent_start", "agent_end", "session_start", "session_tree"]) {
		assert.equal(pi.handlers.has(eventName), true, eventName);
	}
});

test("todo_write updates progress UI and /todos output", async () => {
	const pi = installExtension();
	const ctx = makeCtx();
	const tool = pi.registeredTools.find((registeredTool) => registeredTool.name === "todo_write");

	const result = await tool.execute(
		"call-1",
		{
			todos: [
				{ text: " first item ", status: "pending" },
				{ text: "second item", status: "completed" },
			],
		},
		undefined,
		undefined,
		ctx,
	);

	assert.equal(result.details.completed, 1);
	assert.equal(result.details.total, 2);
	assert.deepEqual(result.details.todos, [
		{ step: 1, text: "first item", status: "pending" },
		{ step: 2, text: "second item", status: "completed" },
	]);
	assert.match(result.content[0].text, /1\/2 todos complete/);
	assert.equal(ctx.statuses.get("plan-mode"), "📋 1/2");
	assert.equal(ctx.widgets.get("plan-todos").length, 2);

	await pi.commands.get("todos").handler("", ctx);
	assert.match(ctx.notifications.at(-1).message, /Plan Progress:/);
});

test("plan mode toggles tool access and blocks destructive bash", async () => {
	const pi = installExtension();
	const ctx = makeCtx();

	await pi.commands.get("plan").handler("", ctx);
	assert.equal(pi.activeTools.includes("edit"), false);
	assert.equal(pi.activeTools.includes("write"), false);
	assert.equal(pi.activeTools.includes("custom_tool"), true);
	assert.equal(ctx.statuses.get("plan-mode"), "⏸ plan");

	const toolCallHandler = pi.handlers.get("tool_call")[0];
	assert.equal(await toolCallHandler({ toolName: "bash", input: { command: "ls -la" } }), undefined);
	assert.deepEqual(await toolCallHandler({ toolName: "bash", input: { command: "rm -rf ." } }), {
		block: true,
		reason: "Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: rm -rf .",
	});

	await pi.commands.get("plan").handler("", ctx);
	assert.deepEqual(pi.activeTools, ["read", "bash", "edit", "write", "custom_tool"]);
});

test("normal mode context filter removes stale injected plan messages", async () => {
	const pi = installExtension();
	const contextHandler = pi.handlers.get("context")[0];
	const result = await contextHandler({
		messages: [
			{ role: "user", content: "keep me" },
			{ customType: "plan-mode-context", role: "user", content: "old" },
			{ role: "user", content: "[PLAN MODE ACTIVE] old" },
			{ role: "assistant", content: [{ type: "text", text: "assistant stays" }] },
		],
	});

	assert.deepEqual(
		result.messages.map((message) => message.content),
		["keep me", [{ type: "text", text: "assistant stays" }]],
	);
});

test("--plan session flag injects read-only planning context", async () => {
	const pi = installExtension({ flagPlan: true });
	const ctx = makeCtx();

	await pi.handlers.get("session_start")[0]({}, ctx);
	const injected = await pi.handlers.get("before_agent_start")[0]();

	assert.equal(pi.activeTools.includes("edit"), false);
	assert.equal(injected.message.customType, "plan-mode-context");
	assert.match(injected.message.content, /\[PLAN MODE ACTIVE]/);
});

test("agent_end can extract a plan and start tracked execution", async () => {
	const pi = installExtension();
	const ctx = makeCtx({ selectValue: "Execute the plan (track progress)" });

	await pi.commands.get("plan").handler("", ctx);
	await pi.handlers.get("agent_end")[0](
		{
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Plan:\n1. Read source files\n2. Run tests" }],
				},
			],
		},
		ctx,
	);

	const executeMessage = pi.sentMessages.find(({ message }) => message.customType === "plan-mode-execute");
	assert.ok(executeMessage);
	assert.match(executeMessage.message.content, /Start with: Source files/);
	assert.deepEqual(pi.activeTools, ["read", "bash", "edit", "write", "custom_tool"]);
});

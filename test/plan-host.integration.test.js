import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import planModeExtension from "../extensions/plan-tracker/index.ts";

// Real Pi 1.3 session, transcript replay, extension commands, and lifecycle.
// Only provider responses and UI are synthetic: no credentials/network/child processes.
async function createHost(t) {
	const dir = await mkdtemp(join(tmpdir(), "pi-plan-host-"));
	let session;
	t.after(async () => {
		session?.dispose();
		await rm(dir, { recursive: true, force: true });
	});
	const host = { requests: [], incomingTools: [], notifications: [], errors: [], dialogs: [], nextOutcome: "stop" };
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
	await runtime.setRuntimeApiKey("openai", "not-a-real-key");
	const loader = new DefaultResourceLoader({
		cwd: dir, agentDir: dir, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [
			(pi) => pi.on("session_tree", () => { host.incomingTools.push(pi.getActiveTools()); }),
			planModeExtension,
		],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const model = { id: "test", name: "test", api: "openai-completions", provider: "openai", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1024 };
	const manager = SessionManager.inMemory(dir);
	({ session } = await createAgentSession({ cwd: dir, model, modelRuntime: runtime, resourceLoader: loader, sessionManager: manager, settingsManager: settings, tools: ["read", "bash", "edit", "write", "todo_write"] }));
	session.agent.streamFunction = (_model, context, options) => {
		host.requests.push(context);
		const outcome = host.nextOutcome;
		host.nextOutcome = "stop";
		const stream = createAssistantMessageEventStream();
		const finish = (stopReason) => {
			const message = { role: "assistant", content: [{ type: "text", text: "Plan reviewed." }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now(), ...(stopReason === "error" ? { errorMessage: "Synthetic provider failure" } : {}) };
			stream.push(stopReason === "stop" ? { type: "done", reason: "stop", message } : { type: "error", reason: stopReason, error: message });
			stream.end(message);
		};
		if (outcome === "wait-for-abort") {
			assert.ok(options.signal);
			if (options.signal.aborted) finish("aborted");
			else options.signal.addEventListener("abort", () => finish("aborted"), { once: true });
		} else queueMicrotask(() => finish(outcome));
		return stream;
	};
	const dialog = async (...args) => { host.dialogs.push(args); throw new Error("Plan approval must not open a dialog"); };
	await session.bindExtensions({
		mode: "rpc", onError: (event) => host.errors.push(event.error),
		uiContext: { setStatus() {}, setWidget() {}, notify: (message) => host.notifications.push(message), select: dialog, confirm: dialog, editor: dialog, input: dialog },
	});
	return Object.assign(host, {
		session, manager,
		state: () => manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "plan-mode").at(-1).data,
		write: (todos) => session.agent.state.tools.find((tool) => tool.name === "todo_write").execute("host-todos", { todos }, undefined),
		async waitUntil(predicate) {
			for (let i = 0; i < 300; i++) {
				assert.deepEqual(host.errors, []);
				if (predicate()) return;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error(`Host timed out (requests=${host.requests.length}, streaming=${session.isStreaming})`);
		},
	});
}
const sorted = (names) => [...names].sort();

test("real AgentSession.navigateTree never overrides newer ordinary tool checkpoints with stale normalTools", { timeout: 15_000 }, async (t) => {
	const host = await createHost(t);
	const { session, manager } = host;
	const original = session.getActiveToolNames();
	await host.write([{ id: "work", text: "Retained checklist", status: "pending" }]);
	await session.prompt("Record the ordinary writable loadout");
	const ordinaryLeaf = manager.getLeafId();

	session.setActiveToolsByName(["read", "todo_write"]);
	await session.prompt("Record a newer deliberately restricted ordinary loadout");
	const restrictedLeaf = manager.getLeafId();
	assert.deepEqual(host.state().normalTools, original, "regression requires a stale ordinary snapshot");
	assert.equal(host.state().enabled, false);
	assert.ok(manager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "system" && entry.message.toolsRemoved?.some((tool) => tool.name === "write")), "real prompt must persist the restrictive delta");
	const compactedLeaf = manager.appendCompaction("Retained checklist and restrictive policy", null, 10);
	assert.deepEqual(sorted(manager.getEntry(compactedLeaf).systemMessage.toolsAdded.map((tool) => tool.name)), ["read", "todo_write"]);

	await session.navigateTree(ordinaryLeaf);
	// Also exercise an incoming checkpoint identical to our outgoing plan loadout.
	const safe = session.getAllTools().filter((tool) => ["read", "grep", "find", "ls", "todo_write"].includes(tool.name)).map((tool) => tool.name);
	session.setActiveToolsByName(safe);
	await session.prompt("Record an ordinary checkpoint equal to the planning loadout");
	const sameAsPlanLeaf = manager.getLeafId();
	assert.deepEqual(host.state().normalTools, original);

	for (const [target, expected] of [[restrictedLeaf, ["read", "todo_write"]], [compactedLeaf, ["read", "todo_write"]], [sameAsPlanLeaf, safe]]) {
		for (const outgoingPlan of [false, true]) {
			await session.navigateTree(ordinaryLeaf);
			assert.deepEqual(sorted(session.getActiveToolNames()), sorted(original));
			if (outgoingPlan) {
				await session.prompt("/plan");
				assert.deepEqual(host.state().toolsBeforePlanMode, original);
			}
			assert.equal((await session.navigateTree(target)).cancelled, false);
			assert.deepEqual(sorted(host.incomingTools.at(-1)), sorted(expected), "Pi restores the transcript before session_tree handlers");
			assert.deepEqual(sorted(session.getActiveToolNames()), sorted(expected), "plan-tracker must not reactivate stale write/bash tools");
			assert.equal(host.state().enabled, false);
			assert.equal(host.state().toolsBeforePlanMode, null);
			assert.equal(host.state().todos[0].id, "work");
			await session.prompt("/plan");
			await session.prompt("/plan off");
			assert.deepEqual(sorted(session.getActiveToolNames()), sorted(expected), "subsequent toggles save the incoming policy, not stale normalTools");
		}
	}
	assert.deepEqual(host.errors, []);
});

test("real Pi restores an explicit plan exit before the next request and preserves saved tools across isolated reload", { timeout: 15_000 }, async (t) => {
	const host = await createHost(t);
	const { session, manager } = host;
	session.setActiveToolsByName(["bash", "todo_write"]); // Deliberately leave read/edit/write inactive.
	const original = session.getActiveToolNames();
	await host.write([{ id: "work", text: "Keep this checklist", status: "pending" }]);
	await session.prompt("/plan");
	await session.prompt("Prepare the plan without executing it");
	const plannedLeaf = manager.getLeafId();
	const restricted = session.getActiveToolNames();
	assert.equal(restricted.includes("bash"), false);
	// Reload only this disposable SDK session, never the running coding-agent harness.
	await session.reload();
	assert.equal(host.state().enabled, true);
	assert.deepEqual(host.state().toolsBeforePlanMode, original);
	assert.deepEqual(session.getActiveToolNames(), restricted);
	await session.prompt("/plan off");
	const offLeaf = manager.getLeafId();
	assert.deepEqual(session.getActiveToolNames(), original);
	assert.equal(host.state().toolsBeforePlanMode, null);
	assert.equal(host.requests.length, 1, "off must not trigger a model request/tool checkpoint");

	await session.navigateTree(plannedLeaf);
	assert.deepEqual(session.getActiveToolNames(), restricted);
	await session.navigateTree(offLeaf);
	assert.deepEqual(host.incomingTools.at(-1), restricted, "Pi still replays the older planning checkpoint");
	assert.deepEqual(session.getActiveToolNames(), original, "the newer explicit exit authorizes restoring its saved tools");
	await session.reload();
	assert.deepEqual(session.getActiveToolNames(), original);
	assert.equal(host.state().enabled, false);
	assert.equal(host.state().todos[0].id, "work");
	assert.equal(host.requests.length, 1);
	assert.deepEqual(host.dialogs, []);
	assert.deepEqual(host.errors, []);
});

test("real Pi settles and aborts without approval dialogs; only /plan execute starts the approved turn", { timeout: 15_000 }, async (t) => {
	const host = await createHost(t);
	const { session, manager } = host;
	const original = session.getActiveToolNames();
	await session.prompt("/plan");
	await host.write([{ id: "done", text: "Finished task", status: "completed" }, { id: "work", text: "Review result", status: "waiting", reason: "Check worker output" }]);
	const restricted = session.getActiveToolNames();
	await session.prompt("Propose a plan");
	assert.equal(session.isStreaming, false);
	assert.equal(host.requests.length, 1, "settlement must not continue automatically");
	assert.equal(host.notifications.filter((message) => message.startsWith("Plan ready.")).length, 1);
	assert.deepEqual(session.getActiveToolNames(), restricted);

	host.nextOutcome = "wait-for-abort";
	const refining = session.prompt("Refine this plan");
	await host.waitUntil(() => host.requests.length === 2);
	await session.abort();
	await refining;
	assert.equal(session.isStreaming, false);
	assert.equal(session.messages.at(-1).stopReason, "aborted");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(session.getActiveToolNames(), restricted, "no asynchronous approval can restore writes after abort");
	assert.equal(host.state().enabled, true);
	assert.equal(host.state().executing, false);

	host.nextOutcome = "error";
	await session.prompt("Try refining again");
	assert.equal(session.messages.at(-1).stopReason, "error");
	assert.equal(host.notifications.filter((message) => message.startsWith("Plan ready.")).length, 1);
	assert.deepEqual(session.getActiveToolNames(), restricted);
	assert.equal(host.requests.length, 3);
	assert.deepEqual(host.dialogs, []);

	await session.prompt("/plan execute");
	await host.waitUntil(() => host.requests.length === 4 && !session.isStreaming);
	assert.deepEqual(session.getActiveToolNames(), original);
	assert.equal(host.state().enabled, false);
	assert.equal(host.state().executing, true);
	assert.equal(host.state().toolsBeforePlanMode, null);
	assert.deepEqual(host.state().todos.map((todo) => todo.status), ["completed", "waiting"]);
	const approvals = manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "plan-mode-execute");
	assert.equal(approvals.length, 1);
	assert.match(approvals[0].content, /Execute the approved plan/);
	assert.match(JSON.stringify(host.requests.at(-1)), /Check worker output/);
	await session.prompt("/plan execute");
	assert.match(host.notifications.at(-1), /not enabled/);
	assert.equal(host.requests.length, 4);
	assert.deepEqual(host.errors, []);
});

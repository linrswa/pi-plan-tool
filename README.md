# pi-plan-tracker

A pi package with a **main-agent-owned, visible checklist** and optional read-only planning. Requires **pi 1.3.0 or newer** for nested-tool enforcement and the final actionable lifecycle boundary.

The checklist works during ordinary conversations: `/plan` is **not** required. Completed and cancelled tasks remain visible until explicitly removed. Workers report execution status; the main agent decides whether a task is actually done.

## Installation

This repository is already configured as a project-local package in `.pi/settings.json`:

```json
{
  "packages": [".."]
}
```

For another project, add its absolute path to that project's `.pi/settings.json`:

```json
{
  "packages": ["/absolute/path/to/pi-plan-tool"]
}
```

Then run `/trust` if required and `/reload`. No global installation is needed.

## Checklist workflow

1. Ask the main agent to track a multi-step task with `todo_write`.
2. The checklist is displayed near the editor in ordinary mode as well as plan mode.
3. Before work, mark an item `in_progress`. Use `waiting` or `blocked` with an optional reason when appropriate.
4. Review background worker results and verify/integrate them before marking a task `completed`.
5. Keep finished items in subsequent updates. `/todos clear` explicitly clears the checklist without stopping jobs.

### `todo_write`

This is a **full-list replacement**, not a patch. Items omitted from an update are removed; `todos: []` explicitly clears the list. Include completed and cancelled tasks unless intentionally removing them.

```json
{
  "todos": [
    { "id": "inspect", "text": "Inspect the implementation", "status": "completed" },
    { "id": "fix", "text": "Implement the fix", "status": "in_progress" },
    { "id": "verify", "text": "Verify the change", "status": "waiting", "reason": "Waiting for worker results" }
  ]
}
```

Supported statuses: `pending`, `in_progress`, `waiting`, `blocked`, `completed`, `cancelled`.

- `id` is optional. Omitted IDs preserve an existing ID when normalized task text matches, one-to-one, even after reordering. New tasks receive unique IDs.
- Reuse the returned ID when renaming a task or linking a background job. Duplicate explicit IDs are rejected without changing the checklist.
- `reason` is optional; it is especially useful for waiting, blocked, or cancelled tasks.
- Cancelled tasks are terminal but are **not** counted as completed.
- Assistant prose, `[DONE:n]` markers, and worker completion events do not change task status. Only explicit checklist updates do.

## Optional read-only planning

`/plan` or `Ctrl+Alt+P` toggles planning without clearing the checklist. `/plan off` explicitly exits without starting work. `--plan` initializes a **new session** in plan mode; it never overrides restored branch state, including an explicitly disabled mode.

While planning, only these **registered** tools are allowed:

- `read`, `grep`, `find`, `ls`
- `questionnaire`, when installed
- `todo_write`
- `subagent_control` with exactly `list`, `status`, or `stop` (omitting `action` defaults to `list`)

**All bash execution is disabled**, including `!`/`!!` user shell commands. There is no shell-string regex allowlist: seemingly read-only shell commands can still execute programs, write files, or issue network requests. Unknown tools, write tools, subagent start/send/scheduling operations, and arbitrary orchestration tools are blocked. The `tool_call` guard also checks nested `ctx.executeTool()` calls, including deferred/codemode tools that are not in the active declarations. Unverified third-party read-only annotations do not grant access.

**Plan mode does not undo changes or automatically stop already-running jobs or schedules.** The extension warns when entering or restoring planning mode. Inspect existing work and explicitly stop it if needed. This is a tool permission gate, not an operating-system sandbox: already-running processes, direct extension code, and external actors remain outside its control.

Ask the agent to explore and write a checklist. After a successful user-initiated planning run finishes automatic retries/recovery, interactive and RPC clients receive a nonblocking reminder. **There is no approval dialog, and settlement or abort never waits for user input.** Review the checklist, then:

- **Approve and start:** send `/plan execute`. This restores the exact saved tool loadout, retains the checklist (including finished tasks), and queues one approved execution turn. Waiting or blocked tasks must still be reviewed.
- **Refine:** send an ordinary message with your changes while remaining in plan mode.
- **Stay:** do nothing; the checklist and restrictions remain in place.
- **Exit without starting work:** use `/plan off`, or toggle `/plan` / `Ctrl+Alt+P`.

Only the explicit `/plan execute` command approves execution; completing a planning response, a background notification, an error, or an abort cannot restore permissions or start work. The command also works without an interactive UI. It requires plan mode and at least one unfinished task; otherwise it reports why execution was not started. There is no automatic completion loop.

## Commands

| Name | Description |
| --- | --- |
| `/plan` | Toggle read-only planning; preserve the checklist |
| `/plan off` | Exit planning without starting work; safe to repeat |
| `/plan execute` | Explicitly approve the plan, restore saved tools, and start one execution turn |
| `/todos` | Show the current checklist, IDs, statuses, and reasons |
| `/todos clear` | Explicitly clear the checklist; leave background jobs alone |
| `Ctrl+Alt+P` | Toggle plan mode |
| `--plan` | Start a new session in plan mode |

## Persistence and context

Every checklist/mode mutation appends a complete branch-local session snapshot **before the tool returns**, including nested `executeTool` updates, which have no independent transcript result. Versioned tool results are display data, not a second source of state; late parallel results cannot roll back a newer snapshot.

Session start, reload, and tree navigation reconstruct from the **active branch**. Tool restrictions are reversible, preserve deliberately inactive tools, and explicitly clear old saved loadouts when leaving planning. Pi's newer transcript-restored tool policy takes precedence over stale ordinary checklist snapshots. An explicit plan exit restores its saved tools even before the next model request records that change. Legacy checklist entries are migrated, including old `completed` booleans.

Each model-context build removes only this extension's old custom context types and injects one current snapshot—even in ordinary mode and on background wake-ups. User text containing `[PLAN MODE ACTIVE]` or `[EXECUTING PLAN]` is never removed.

The widget computes theme colours during rendering and truncates to terminal width.

## Optional subagent integration

No private imports or shared filesystem are required. The public `pi.events` contract is:

### Query main-agent context

Emit `pi-plan:context-request` with:

```ts
{
  ownerSessionId: string,
  respond: (state: { readOnly: boolean; taskId?: string }) => void
}
```

Only the matching active session responds. `taskId` is present only when exactly one checklist item is `in_progress`. The subagent extension should use `readOnly` to reject new work during planning and may associate jobs with that task ID.

### Report worker state

Emit `pi-subagent:state` with:

```ts
{
  version: 1,
  ownerSessionId: string,
  runs: Array<{
    id: string;
    task: string;
    taskId?: string;
    status: "queued" | "running" | "completed" | "failed" | "aborted";
    completionNotification?: string;
  }>;
}
```

On session start and tree navigation, this extension also emits `pi-subagent:snapshot-request` with `{ ownerSessionId, respond(snapshot) }`. Subscriptions are session-scoped and disposed idempotently on shutdown/reload. Foreign-session snapshots and obsolete callbacks are ignored.

Jobs whose `taskId` matches a current checklist item get concise badges beside it. Other jobs appear in an unlinked summary. A completed job is shown as **finished; review** while its linked task is unresolved, and as **finished** once the main agent marks that task completed or cancelled. It never marks the todo complete by itself. Snapshots never mutate tasks or trigger model turns. The subagent extension owns completion notifications/wake-ups; the main agent reviews those results and updates `todo_write`.

## Development

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm run test:full
```

`test:full` runs typecheck, regression tests, and `npm pack --dry-run`. Development dependencies are aligned with pi 1.3.0; host-provided packages remain peer dependencies and are not bundled.

Regression coverage includes durable nested updates, out-of-order results, ID preservation/collisions, all statuses, full-list clearing, read-only bypass attempts, tool-loadout restoration, session/tree/reload behavior, user-text preservation, nonblocking settlement and explicit command approval, completed-task retention, session-scoped events, and no false completion from worker status. Real Pi SDK tests exercise `AgentSession.navigateTree()`, transcript deltas and compaction checkpoints, isolated reloads, aborts, and execution turns with a synthetic provider (no network or credentials).

## Files

- `extensions/plan-tracker/index.ts` — tool, commands, branch state, permissions, context, lifecycle, UI, and event-bus integration
- `extensions/plan-tracker/utils.ts` — identity/status normalization and integration payload validation
- `test/plan-tracker.test.js` — focused extension regression coverage
- `test/plan-host.integration.test.js` — real Pi SDK navigation, reload, settlement, and approval regressions

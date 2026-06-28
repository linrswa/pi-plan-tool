# pi-plan-tracker

A pi package that adds Claude Code-style plan tracking to pi.

It gives you a read-only planning mode, a visible todo checklist, and tracked execution once you approve the plan.

## Features

- `/plan` toggles read-only planning mode
- Built-in `edit` and `write` tools are disabled while planning
- Destructive `bash` commands are blocked while planning
- `todo_write` lets the model maintain a visible checklist
- `/todos` shows current progress
- `Ctrl+Alt+P` toggles plan mode

## Use in this repo

This repo is already configured as a project-local pi package:

```json
{
  "packages": [".."]
}
```

Start or reload pi here:

```text
/trust
/reload
/plan
```

## Use in another project

Add this package path to that project's `.pi/settings.json`:

```json
{
  "packages": ["/absolute/path/to/pi-plan-tracker"]
}
```

Then run:

```text
/trust
/reload
/plan
```

## Workflow

1. Run `/plan`.
2. Ask pi to inspect the code and propose a plan.
3. Review the generated checklist.
4. Choose **Execute the plan** when prompted.
5. pi restores normal tool access and tracks progress with `todo_write`.

## Commands and tools

| Name | Type | Description |
| --- | --- | --- |
| `/plan` | command | Toggle read-only plan mode |
| `/todos` | command | Show the current checklist |
| `Ctrl+Alt+P` | shortcut | Toggle plan mode |
| `todo_write` | tool | Replace the visible checklist with `pending`, `in_progress`, or `completed` items |

## Development

Install dev dependencies:

```bash
npm install
```

Run checks:

```bash
npm test
npm run typecheck
npm run test:full
```

`test:full` runs typecheck, unit tests, and `npm pack --dry-run`.

## Files

- `extensions/plan-tracker/index.ts` - extension commands, UI, state, tool control
- `extensions/plan-tracker/utils.ts` - plan parsing, todo normalization, bash allowlist
- `test/plan-tracker.test.js` - Node test coverage for utilities and extension behavior

## Notes

This started from pi's `examples/extensions/plan-mode` and was trimmed into a shareable pi package.

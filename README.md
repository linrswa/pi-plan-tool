# pi-plan-tracker

Project-local pi package for a plan/todo tracker extension.

## Use locally

This repo is already enabled for this project by `.pi/settings.json`:

```json
{
  "packages": [".."]
}
```

Start/reload pi in this repo:

```text
/trust
/reload
/plan
```

## Commands / tool

- `/plan` - toggle read-only plan mode
- `/todos` - show current plan progress
- `Ctrl+Alt+P` - toggle plan mode
- `todo_write` - model tool that updates checklist items as `pending`, `in_progress`, or `completed`

## Files

- `extensions/plan-tracker/index.ts` - extension commands, UI, state, tool control
- `extensions/plan-tracker/utils.ts` - plan parsing, DONE markers, bash allowlist

Copied from pi's `examples/extensions/plan-mode` as the starting point.

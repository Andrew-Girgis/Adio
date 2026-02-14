# Contributing

## Setup
1. Install Node 20+ and pnpm 9+.
2. Run `pnpm i`.
3. Copy `.env.example` to `.env`.
4. Run `pnpm dev`.

## Repository Conventions
- Shared protocol and engine logic lives in `packages/core`.
- Transport/orchestration logic lives in `apps/server`.
- UI/audio rendering lives in `apps/web`.

## Development Workflow
1. Make focused changes.
2. Run `pnpm typecheck`.
3. Run `pnpm build` when touching package boundaries.
4. Update docs when behavior changes.

## Pull Request Checklist
- [ ] Commands and state transitions are tested manually.
- [ ] Barge-in still interrupts active audio.
- [ ] Docs updated if protocol or env changed.
- [ ] No secrets in commits.

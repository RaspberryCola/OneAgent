# Backend Architecture ADR (A1)

## Status

Accepted for refactor planning.

## Scope

This ADR defines the target backend module boundaries for `src-tauri` and the migration constraints that all follow-up refactor tasks must respect.

It does not require immediate behavior changes.

## Context

The current backend already has a usable top-level flow:

```text
channel_api -> gateway -> runtime/storage/adapters
```

But the core modules are over-concentrated:

- `runtime/mod.rs` mixes use cases, session lifecycle, state transitions, projection writes, replay, and UI emission.
- `storage/mod.rs` mixes connection, migrations, repositories, row mappers, and serialization helpers.
- `agent_adapters/acp.rs` mixes adapter facade, live actor, JSON-RPC transport, terminal/fs bridge, prompt encoding, and protocol parsing.

This makes the backend hard to split across multiple agents and hard to evolve safely.

## Decision

The backend will evolve toward the following structure:

```text
channel_api
  responsibility: Tauri command DTO mapping only

gateway
  responsibility: facade + light validation only

application
  responsibility: use-case orchestration

runtime
  responsibility: live session lifecycle, recovery coordination, runtime state

agent_adapters
  responsibility: protocol-specific integration

storage
  responsibility: repositories, migrations, transaction boundary, read/write persistence

domain
  responsibility: shared backend domain types and rules

capability_services
  responsibility: cross-cutting capability helpers
```

## Target Boundaries

### `channel_api`

Allowed:

- Deserialize Tauri command inputs
- Call `gateway`
- Map errors to `BackendError`

Not allowed:

- Direct storage orchestration
- Runtime state repair logic
- Attachment persistence logic

### `gateway`

Allowed:

- Facade methods
- Thin validation
- Aggregate responses from application/runtime/storage services

Not allowed:

- Stateful business workflows
- Direct multi-step persistence logic
- Runtime state correction logic

### `application`

Allowed:

- Use-case orchestration
- Transaction-scoped coordination
- Combining runtime, repositories, and capability services

Primary landing place for:

- Conversation creation/import/send/cancel/delete
- Task-run creation/completion/cancellation
- Permission resolution
- Workspace bootstrap
- Attachment persistence

### `runtime`

Allowed:

- Session pool and hot/cold session handling
- Recovery and replay coordination
- Runtime state machine
- Stream event intake and dispatch into projectors

Not allowed:

- Repository implementation details
- Full API DTO assembly as its main abstraction

### `agent_adapters/acp`

Must be split into:

- adapter facade
- live session API
- actor loop
- JSON-RPC process transport
- prompt codec
- parser
- permission mapping
- client fs bridge
- client terminal bridge

### `storage`

Must be split into:

- `sqlite/connection`
- `sqlite/migrations`
- `sqlite/tx`
- `repositories/*`
- `mappers/*`

`storage/mod.rs` becomes a facade and re-export surface, not the implementation dump.

## Stable Contracts During Refactor

Until an explicit follow-up ADR changes them, the following must remain stable:

### Public Tauri command surface

- Existing command names in `channel_api`
- Existing request/response JSON shapes consumed by the frontend

### Runtime event names

- `conversation:state_changed`
- `conversation:message_appended`
- `conversation:message_updated`
- `conversation:tool_call_changed`
- `conversation:permission_requested`
- `conversation:permission_resolved`
- `conversation:terminal_output`
- `conversation:turn_finished`
- `task_run:state_changed`

### Persistence behavior

- Existing SQLite file location
- Existing table names, unless a migration explicitly changes them
- Existing conversation/task identity semantics

## Migration Rules

### Rule 1: Prefer facade preservation

When splitting a large module, keep the existing facade in place first and move implementation behind it. Do not force wide call-site rewrites in the same step unless necessary.

### Rule 2: Split by responsibility, not by file size alone

Moving functions into smaller files without a boundary change is not enough. Each extracted file must own one coherent responsibility.

### Rule 3: Add tests before deep behavior moves

For high-risk paths, add or strengthen regression tests before moving logic:

- replay/recovery
- permission resolution
- streaming message projection
- terminal output handling
- task completion summary

### Rule 4: No cross-cutting “cleanup” in structural PRs

Structural refactor PRs should avoid opportunistic semantic changes unless directly required by the boundary move.

### Rule 5: One write scope per task

Each agent task should have a narrow write scope. Avoid tasks that simultaneously rewrite `storage`, `runtime`, and `acp`.

### Rule 6: Introduce transactions explicitly

Where a use case spans multiple writes, the transaction boundary must be made explicit instead of relying on sequential success.

## Initial Module Ownership Map

This map is for refactor coordination, not permanent code ownership.

- `storage/**`: repository and persistence task owners
- `runtime/session_manager.rs`, `runtime/recovery.rs`: runtime lifecycle task owners
- `runtime/stream_processor.rs`, `runtime/projector*`: projection task owners
- `agent_adapters/acp/**`: ACP task owners
- `application/**`, `gateway/mod.rs`: use-case orchestration task owners
- `docs/**`: architecture and coordination task owners

## Non-Goals

This ADR does not currently require:

- switching away from SQLite
- introducing a DI framework
- converting the backend into multi-process services
- full event-sourcing conversion
- typing every ACP JSON payload immediately

## Follow-up

All subsequent refactor tasks should reference this ADR as the baseline architecture contract.


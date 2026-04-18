# OneAgent Backend Refactor Next Plan

## 1. Purpose

This is the single source of truth for backend refactor work after A1/A2/A3/B1/B2/B3/D1.

It replaces:

- `docs/backend-architecture-adr-a1.md`
- `docs/backend-architecture-refactor-plan.md`
- `docs/backend-refactor-collaboration-a1.md`

## 2. Baseline Snapshot (2026-04-19)

Completed:

- `storage` split is wired: `sqlite/*`, `repositories/*`, `mappers/*`
- transaction entry exists: `storage/sqlite/tx.rs`
- `runtime` split is wired: `session_manager`, `recovery`, `stream_processor`, `projector/*`, `snapshot_model`
- `application/*` is wired through `gateway`
- ACP physical modularization is wired under `agent_adapters/acp/*`

Partially completed:

- B4: application services are mostly thin wrappers; use-case orchestration is still concentrated in `runtime/mod.rs`
- C2: ACP typed protocol coverage is incomplete
- D2: tests pass (`cargo test`), but use-case regression matrix is still missing
- D3: synchronous SQLite access is still directly used on async paths

## 3. Stable Contracts (Do Not Break)

- Existing Tauri command names and request/response JSON fields
- Existing runtime event names used by frontend:
  - `conversation:state_changed`
  - `conversation:message_appended`
  - `conversation:message_updated`
  - `conversation:tool_call_changed`
  - `conversation:permission_requested`
  - `conversation:permission_resolved`
  - `conversation:terminal_output`
  - `conversation:turn_finished`
  - `task_run:state_changed`
- Existing SQLite location and identity semantics

## 4. Next-Stage Goals

### G1. Finish B4 (application-centric use cases)

- Move orchestration skeletons for `create/import/send/cancel/delete` from `runtime/mod.rs` into `application/*`
- Keep `runtime` focused on session lifecycle, replay/recovery, stream processing, projection dispatch

Acceptance:

- `gateway` remains thin facade
- `application` owns use-case orchestration
- `runtime/mod.rs` size and responsibilities are reduced

### G2. Expand transaction coverage (A3 continuation)

- Extend atomic boundaries to remaining multi-write flows:
  - `import conversation`
  - `cancel turn`
  - any additional multi-step write flow discovered during B4

Acceptance:

- no multi-write flow relies on sequential best-effort success

### G3. Close C2 (ACP typing)

- Add/extend typed models for key ACP message families
- Keep `serde_json::Value` usage at protocol boundary only

Acceptance:

- key ACP update/permission/session messages are parsed into typed intermediates

### G4. Close D2 (regression matrix)

- Add behavior tests for:
  - `create/import/send/cancel/replay`
  - permission auto/manual resolve
  - terminal output accumulation
  - message/tool_call projection transitions

Acceptance:

- failures in core workflows are caught without manual UI verification

### G5. Advance D3 (async/storage boundary)

- Reduce synchronous DB work on high-frequency stream paths
- Introduce explicit boundaries for future `spawn_blocking`/pool migration

Acceptance:

- high-frequency stream handling avoids repeated full-list queries
- clear seam exists for future storage runtime isolation

## 5. Execution Order

1. B4 completion (G1)
2. Transaction expansion (G2)
3. D2 regression matrix (G4) in parallel with G1/G2 where possible
4. C2 typing completion (G3)
5. D3 boundary hardening (G5)

## 6. Parallel Work Rules

Write scopes (one primary scope per task):

- `src-tauri/src/storage/**`
- `src-tauri/src/runtime/**`
- `src-tauri/src/agent_adapters/acp/**`
- `src-tauri/src/application/**`
- `src-tauri/src/gateway/mod.rs`
- `docs/**`

Rules:

1. Preserve facades first, then migrate internals
2. Prefer sequence: extract -> move without behavior change -> tests -> behavior change
3. Do not combine unrelated cross-layer rewrites in one patch
4. Any cross-scope edit must explain why it is necessary

## 7. Per-PR Checklist

- Which boundary changed?
- Which public facade stayed stable?
- Which follow-up work is unblocked?
- Which tests were added/updated?
- What was intentionally left untouched?

## 8. Current Focus Queue

- P0: B4 completion (`application` orchestration extraction)
- P1: A3 continuation (transaction coverage completion)
- P2: D2 regression matrix
- P3: C2 typed ACP model completion
- P4: D3 boundary/performance hardening


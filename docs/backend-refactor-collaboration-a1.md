# Backend Refactor Collaboration Contract (A1)

## Purpose

This document defines how parallel agents should work on the backend refactor without stepping on each other.

## Required Behavior For Every Task

### 1. Respect write scopes

Each task should primarily modify one of the following areas:

- `src-tauri/src/storage/**`
- `src-tauri/src/runtime/**`
- `src-tauri/src/agent_adapters/acp/**`
- `src-tauri/src/application/**`
- `src-tauri/src/gateway/mod.rs`
- `docs/**`

If a task needs to touch more than one major area, it must explain why the boundary change is unavoidable.

### 2. Preserve existing facades first

When moving code out of a giant module:

- keep the current public entry points working
- add re-exports or thin wrapper methods first
- move call sites later

### 3. Avoid behavior and structure changes in the same patch unless necessary

Preferred sequence:

1. extract files
2. move logic with no semantic change
3. add tests
4. change semantics

### 4. Protect the frontend contract

Do not rename existing:

- Tauri commands
- JSON response fields used by the frontend
- runtime event names

unless that change is explicitly scoped and coordinated.

### 5. Prefer additive scaffolding

During early stages, it is acceptable to add:

- new modules
- wrappers
- adapter layers
- duplicate-but-temporary facades

It is not acceptable to remove a stable entry point without replacing it in the same task.

## Suggested Task Ownership

### Storage owners

Own:

- repository extraction
- migrations split
- tx boundary
- row mapper split

Should avoid:

- ACP parser changes
- runtime stream projector semantics

### Runtime owners

Own:

- session lifecycle
- recovery
- state transitions
- stream processing orchestration

Should avoid:

- raw SQL changes outside agreed repository interfaces
- ACP transport details

### ACP owners

Own:

- JSON-RPC process
- ACP live actor
- ACP parser
- prompt codec
- fs/terminal client bridge

Should avoid:

- changing runtime projection behavior in the same patch

### Application/gateway owners

Own:

- use-case services
- facade cleanup
- bootstrap orchestration
- attachment persistence service extraction

Should avoid:

- direct repository implementation rewrites unless coordinated

## PR / Patch Checklist

Every refactor patch should answer:

- What boundary was introduced or clarified?
- Which facade stayed stable?
- Which follow-up tasks does this unblock?
- What tests were added or updated?
- What was intentionally left untouched?

## Conflict Avoidance

### High-conflict files today

- `src-tauri/src/runtime/mod.rs`
- `src-tauri/src/storage/mod.rs`
- `src-tauri/src/agent_adapters/acp.rs`

### Preferred strategy

- create new target files first
- move code out gradually
- reduce edits to the legacy giant file to the minimum necessary wrapper changes

## Initial Skeleton Directories

The source tree now includes placeholder landing zones for:

- `src-tauri/src/application/`
- `src-tauri/src/agent_adapters/acp/`
- `src-tauri/src/storage/sqlite/`
- `src-tauri/src/storage/repositories/`
- `src-tauri/src/storage/mappers/`

These placeholders do not mean the modules are wired into the build yet. They exist to standardize where follow-up work lands.


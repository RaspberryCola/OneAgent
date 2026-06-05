# OneAgent Backend Design

## 1. Document Purpose

This document defines the long-term design specification for the OneAgent backend.

It is not an “implementation note” for a particular release version, but rather a set of architectural constraints, module boundaries, and engineering principles that the backend should adhere to as it continues to evolve.

The goal is for the backend to exhibit the following characteristics:

- Clear layering within a single-process desktop application scenario
- Long-term maintainability
- Low coupling, replaceable, and testable
- Allows multiple agents / multiple developers to evolve in parallel
- Accommodates current product requirements while leaving extension points for future protocols, capabilities, and runtime behavior



## 2. Design Goals

The OneAgent backend is a unified Agent Runtime running locally on the desktop. Its responsibility is not to do “everything,” but to provide a stable, evolvable middle layer between the upper-level UI and the lower-level agents/protocols.

The backend should satisfy the following goals:

- Unified management of core entities such as workspaces, conversations, task runs, permissions, tool calls, and terminals
- Integration with different agents/protocols without leaking protocol details globally
- Expose stable command and event contracts externally
- Maintain clear internal boundaries among four major layers: use-case orchestration, runtime, protocol adaptation, and storage
- Keep behavior predictable under failure, recovery, restart, concurrency, and incremental refactoring scenarios

## 3. Core Principles

### 3.1 Unidirectional Dependencies

The backend must follow unidirectional dependencies:

```text
channel_api -> gateway -> application -> runtime / capability_services / storage / agent_adapters
domain is shared by all backend modules but does not depend on upper layers
```

The following are prohibited:

- `channel_api` directly operating `storage`
- `gateway` directly hosting multi-step business processes
- `runtime` depending on specific SQL details
- `domain` depending on infrastructure such as Tauri, SQLite, tokio subprocesses, etc.

### 3.2 Define Boundaries First, Then Pursue Abstraction

The backend design does not pursue “many layers of abstraction,” but instead pursues:

- A clear reason for why each layer exists
- A single responsibility for each module
- A stable dependency direction

If a module carries multiple levels of abstraction simultaneously, it is a substandard design, even if the file is not large.

### 3.3 Facade Stability Takes Priority

During refactoring, prioritize keeping the facade stable, and then migrate the internal implementation.

This means:

- You may add wrappers / re-exports first
- You may extract implementations and then gradually migrate callers
- “Rewrite all call sites in one shot” is discouraged

### 3.4 Separate Structural Changes from Behavioral Changes

Backend structural adjustments should be separated from semantic modifications as much as possible:

1. Split files and boundaries first
2. Migrate logic next
3. Then modify behavior

This reduces regression risk and improves review readability.

### 3.5 Stable External Contracts

In the absence of an explicit protocol upgrade plan, the following are considered stable by default:

- Tauri command names
- Command request/response JSON structures
- Event names emitted by the runtime
- Core semantics of conversation / task / permission

## 4. Module Layering

### 4.1 `channel_api`

Responsibilities:

- Expose `#[tauri::command]`
- Deserialize input
- Call `gateway`
- Convert errors into a frontend-stable error structure
- Manage multi-channel access (Desktop Tauri IPC, WebUI HTTP/WS, IM channels)

Sub-modules:
- `web/` - WebUI channel, providing HTTP/WS interfaces and JWT authentication
- `im/` - IM channel, integrating Lark and WeChat bots

Not responsible for:

- Business orchestration
- Domain validation beyond path correction
- Runtime state repair
- Storage details

### 4.2 `gateway`

Responsibilities:

- Backend facade
- Aggregate results from multiple services
- Perform lightweight input validation and parameter shaping

Not responsible for:

- Multi-step business processes
- Orchestration of multiple persistence writes
- Protocol/adapter implementation details

### 4.3 `application`

This is the backend use-case service layer.

Responsibilities:

- Host explicit business use cases
- Manage transaction boundaries
- Coordinate runtime, repositories, capability services, adapters

Typical use cases:

- CreateConversation
- ImportConversation
- SendUserMessage
- CancelTurn
- ResolvePermission
- BootstrapWorkspace
- PersistAttachment

Principles:

- One public method should correspond to one clear business action
- The use-case layer does not write raw SQL
- The use-case layer does not parse protocol messages

### 4.4 `runtime`

This is the session runtime layer.

Responsibilities:

- Manage the live session pool
- Manage hot/cold sessions and recovery
- Drive the runtime state machine
- Receive agent stream events
- Dispatch stream events to projector / event bus
- Manage state cache (StateCache)
- Manage snapshots (SnapshotManager/SnapshotModel)
- Manage turn lifecycle (Turn)

Internal components:
- `session_manager` - Session lifecycle management
- `state_cache` - In-memory state cache
- `snapshot_manager` - Snapshot persistence management
- `snapshot_model` - Snapshot data model
- `stream_processor` - Stream event processing
- `projector` - Event projection
- `event_bus` - Event broadcasting
- `recovery` - Session recovery
- `turn` - Turn management

Not responsible for:

- Repository implementations
- Command DTO assembly
- Lengthy protocol parsing code

### 4.5 `agent_adapters`

Responsibilities:

- Encapsulate agent/protocol differences
- Provide a unified behavioral interface to the runtime

Adapter types:
- `acp/` - ACP protocol adapter, supporting agents that follow the standard ACP protocol (e.g., Claude Code)
- `compat/` - Compatibility adapter, supporting agents using traditional protocols

Current design principles:

- Upper layers only depend on the unified adapter trait
- Protocol details remain confined within the adapter
- Protocol transport, parser, prompt codec, and permission mapping should be further layered

### 4.6 `storage`

Responsibilities:

- Provide persistence capabilities
- Manage migrations
- Manage transactions
- Provide repositories
- Manage persistence for read models / snapshots / event logs
- Provide unified error handling (StorageError)
- Provide a Database facade encapsulation

Sub-modules:
- `sqlite/` - SQLite connection, migration, transaction management
- `repositories/` - CRUD operations for each entity
- `mappers/` - Row-to-domain mapping logic
- `facade.rs` - Unified Database facade
- `error.rs` - Storage layer error definitions

Not responsible for:

- Business process orchestration
- Frontend DTO assembly
- Runtime state machine

### 4.7 `capability_services`

Responsibilities:

- Provide cross-cutting capabilities
- Do not host main business processes

Typically includes:

- MCP registry - MCP server registration and management
- skill discovery/index - Skill discovery and indexing
- permission policy engine - Permission policy engine
- agent discovery / launch helper - Agent discovery and launch helper
- browser - Browser automation (CDP integration)
- crypto - Cryptographic service (secure storage)
- terminal - Terminal session management
- system_path - System path handling (cross-platform compatibility)

### 4.8 `domain`

Responsibilities:

- Host shared domain models and rules for the backend
- Provide a stable type foundation

Principles:

- `domain` must be as decoupled from concrete infrastructure as possible
- If a type only serves inside a specific adapter, it should not enter `domain`
- If a type is an external API DTO, it should not be conflated with an internal snapshot model

## 4.9 Multi-Channel Architecture

OneAgent supports multiple access channels, managed uniformly through the `channel_api` module:

### Desktop Channel (Tauri IPC)
- The primary channel, communicating with the frontend via Tauri IPC
- Supports native desktop experience
- Direct access to local resources

### WebUI Channel (HTTP/WS)
- Provides web access via an axum HTTP server
- Supports JWT authentication
- Configurable port (default 19520)
- Supports automatic LAN IP detection

### IM Channel (Lark/WeChat)
- Integrated via the im-sidecar process
- Supports Lark and WeChat bots
- Asynchronous plugin system initialization
- Receives messages through the event bus

## 4.10 Capability Service Detailed Design

### Browser Automation Service
- Based on CDP (Chrome DevTools Protocol) integration
- Supports headless and headed modes
- Provides operations such as page navigation, click, fill, scroll
- Supports screenshot functionality
- Configurable viewport size and CDP port

### Crypto Service
- Provides encryption key management
- Supports secure storage (e.g., WebUI authentication configuration)
- Cross-platform compatible

### Terminal Service
- Manages terminal session lifecycle
- Supports spawn, write, resize, close operations
- Integrated with the Tauri shell plugin

### SystemPath Service
- Handles cross-platform system paths
- Supports agent command lookup
- Provides path diagnostic functionality

## 5. Recommended Directory Structure

The target directory structure is as follows:

```text
src-tauri/src/
  application/
    agents.rs
    attachments.rs
    conversations.rs
    permissions.rs
    task_runs.rs
    workspaces.rs
    mod.rs
  runtime/
    event_bus.rs
    projector.rs
    recovery.rs
    session.rs
    session_manager.rs
    snapshot_manager.rs
    snapshot_model.rs
    state_cache.rs
    stream_processor.rs
    turn.rs
    types.rs
    mod.rs
  agent_adapters/
    acp/
      adapter.rs
      process.rs
      parser.rs
      permission.rs
      live_session.rs
      types.rs
      mod.rs
    compat.rs
    mod.rs
  storage/
    sqlite/
      connection.rs
      migrations.rs
      tx.rs
    repositories/
    mappers/
    facade.rs
    error.rs
    mod.rs
  capability_services/
    agent_discovery.rs
    agent_launch.rs
    browser.rs
    crypto.rs
    mcp.rs
    policy.rs
    skills.rs
    system_path.rs
    terminal.rs
    mod.rs
  domain/
    mod.rs
  gateway/
    mod.rs
  channel_api/
    web/
      auth.rs
      manager.rs
      mod.rs
    im/
      mod.rs
    mod.rs
  lib.rs
  main.rs
```

## 6. Domain Modeling Specification

### 6.1 Core Entities

The backend should model around at least the following entities:

- Workspace
- AgentProfile
- Conversation
- AgentSessionBinding
- TaskRun
- RuntimeEvent
- ConversationSnapshot
- MessageProjection
- ToolCallProjection
- PendingPermissionRequest
- PermissionDecision
- TerminalRecord

### 6.2 Separation of Entities and Projections

A strict distinction must be made between:

- Domain entities
- Events
- Projections / read models
- API DTOs
- Snapshot models

It is forbidden to conflate them into the same struct just because “the fields are similar.”

For example:

- `ConversationState` can serve as an external aggregate view
- But it should not by default be used as the internal snapshot storage model

### 6.3 State Modeling Must Be Explicit

All long-lived objects should have explicit states, for example:

- conversation runtime state
- task run status
- tool call status
- pending permission status
- terminal status

Principles:

- State enums must be preferred over string literals
- State transition rules should be centralized, not implicitly scattered across multiple modules

## 7. State and Consistency Specification

### 7.1 Which State Is the Persistent Truth and Which Is In-Memory

A clear distinction must be made between:

- In-memory live state
- Persistent snapshot state
- Replayable event state

Recommended rules:

- Whether a live session exists: determined by in-memory state
- Historical audit and replay: based on the event log
- UI initialization aggregate view: based on snapshot + projection
- “Real-time connection status” that cannot be directly trusted across restarts: must not be persisted as strong truth

### 7.2 Multi-Step Writes Must Have Transaction Boundaries

Any business use case that involves multiple related writes must define a transaction boundary.

Typical examples include:

- create conversation
- import conversation
- create task run
- resolve permission
- cancel turn

Principles:

- Transaction boundaries belong to `application` + `storage/tx`
- Do not rely on “it usually works if executed sequentially without issues”

### 7.3 Snapshots Are Not DTO Caches

The purpose of snapshots should be:

- Speed up recovery
- Reduce initialization aggregation cost
- Preserve internal stable state

Snapshots should not become “stuffing the entire frontend JSON response into the database as-is.”

### 7.4 Event Log Is Not a Miscellaneous Log

The event log must have a clear purpose:

- Historical audit
- Troubleshooting
- Replay / recovery assistance

If an event serves neither recovery, nor diagnostics, nor audit, it should not be appended arbitrarily.

## 8. Adapter Design Specification

### 8.1 Upper Layers Depend Only on Unified Interfaces

The `runtime` and `application` layers must only depend on the capabilities exposed by the adapter trait and must not be aware of protocol details.

### 8.2 Protocol Internal Layering

Every complex protocol adapter must be further broken down into:

- facade
- live session API
- actor
- transport
- parser
- codec
- local capability bridge

It is forbidden to keep them piled into a single file over the long term.

### 8.3 `Value` Stays Only at Protocol Boundaries

`serde_json::Value` may be used for:

- Raw protocol input/output
- Short-term compatibility layers

But it should not be used as a general-purpose business model throughout the entire system.

Principles:

- The closer to the business layer, the more explicit the types should be
- The closer to the protocol boundary, the more `Value` can be retained

## 9. Storage Design Specification

### 9.1 Storage Layer Responsibilities

The storage layer should be divided into at least four categories of responsibility:

- connection
- migrations
- repositories
- row mappers / serialization helpers

### 9.2 Repository Organized by Aggregate or Read Model Boundaries

Organization by the following boundaries is recommended:

- conversations
- task_runs
- events
- snapshots
- messages
- tool_calls
- permissions
- terminals
- mcp
- skills
- agent_profiles
- workspaces

### 9.3 Do Not Put All Queries Into a Single Giant `Database` Object

A `Database` or `Storage` facade may exist, but should only serve as:

- A connection holder
- A repository composition entry point
- A transaction entry point

It should not continue to evolve into “all CRUD is inside it.”

### 9.4 It Is Permissible to Continue Using SQLite Now, but the Boundary Must Be Isolated

Whether `rusqlite` is used currently is not the most critical issue.

What is critical:

- Upper layers do not depend on a specific driver
- High-frequency streaming paths should not scatter numerous synchronous queries
- If future optimization requires a connection pool or blocking boundary, the global structure must not need to be completely overturned

## 10. Runtime Design Specification

### 10.1 Runtime Responsibility Boundary

`runtime` is only responsible for runtime coordination, not for everything.

Internal responsibilities that must be separated:

- session manager
- recovery
- stream processor
- projector
- event bus

### 10.2 Stream Event Processing Must Be Decomposable

Any function similar to `apply_stream_event` must be further broken down if it simultaneously performs multiple tasks such as:

- Pushing state
- Writing projections
- Writing event log
- Handling permissions
- Emitting UI events

Recommended pattern:

```text
RuntimeStreamEvent
  -> stream processor
  -> projector command(s)
  -> repositories + event bus
```

### 10.3 Recovery Logic Is Independent

Recovery/replay logic must be independently modularized; it cannot be scattered within the main flows of create/send/cancel.

## 11. Gateway and API Design Specification

### 11.1 `gateway` Is a Facade, Not the Business Core

The responsibility of `gateway` is to “provide a stable entry point for the frontend,” not to host complex business rules.

Allowed:

- Input validation
- Lightweight parameter grooming
- Aggregating results from multiple services

Not allowed:

- Long-chain state correction
- Multi-step persistence flows
- Protocol recovery logic

### 11.2 `channel_api` Must Be as Thin as Possible

`channel_api` should only serve as a desktop command adaptation layer and must not evolve into a second gateway.

## 12. Error Handling Specification

### 12.1 Layered Errors

Errors must be categorized by layer:

- adapter error
- runtime error
- storage error
- gateway/application validation error
- frontend-facing backend error

It is forbidden to swallow all context with a single broad error enum.

### 12.2 Error Information Must Be Diagnosable

Principles:

- For developers: provide sufficient diagnostic information
- For the frontend: provide stable error types/codes
- For users: do not expose meaningless low-level details

## 13. Testing Specification

### 13.1 Testing Pyramid

The backend should have at least the following test levels:

- parser/unit tests
- repository tests
- runtime use-case tests
- recovery tests
- projector tests
- integration tests for critical flows

### 13.2 Prioritize High-Risk Paths

Priority coverage should be given to:

- create/import/send/cancel
- replay/recovery
- permission auto/manual resolution
- terminal output accumulation
- tool call / diff / message chunk projection

### 13.3 Add Tests Before Structural Refactoring

For high-risk large modules, a regression safety net must be in place before deep refactoring.

## 14. Parallel Development Specification

### 14.1 Split Tasks by Write Domain

Recommended task boundaries:

- `storage/**`
- `runtime/**`
- `agent_adapters/acp/**`
- `application/**`
- `docs/**`

Do not let multiple agents deeply modify the same huge file simultaneously.

### 14.2 One Theme Per Task

A branch should do only one thing, for example:

- storage split
- runtime session manager extraction
- acp modularization

Do not mix “structural split + semantic change + cleanup” together.

### 14.3 Maintain Facade Compatibility

During a major refactoring, old entry points can be temporarily retained as long as they no longer carry the core implementation.

## 15. Non-Goals

This document does not require the current backend to:

- Immediately turn into microservices
- Immediately change the database
- Immediately become fully event-sourced
- Immediately make all protocol JSON strongly typed
- Introduce a heavy DI container

These can all be topics for future optimization but are not part of the current foundational architecture specification.
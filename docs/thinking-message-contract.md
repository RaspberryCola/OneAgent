# Thinking Message Contract

This document defines the backend-to-frontend contract for agent thinking output in OneAgent.

## Goal

Expose agent reasoning in a separate timeline item so the UI can render:

- streaming thinking content
- a completed thinking block before the final answer
- final answer text without leaked `<think>` tags

## Scope

This applies to ACP-backed conversations first.

Supported thinking sources:

1. Native protocol thought/reasoning updates, if the agent emits them.
2. Inline `<think>...</think>` or `<thinking>...</thinking>` tags embedded in assistant text.

## Timeline Shape

Thinking is represented as a normal `MessageProjection` with a dedicated `kind`.

### TypeScript

`MessageProjection.kind = "thinking"`

`content_json` payload:

```json
{
  "text": "reasoning content",
  "status": "thinking",
  "stream": true,
  "duration_ms": null
}
```

Completed thinking message:

```json
{
  "text": "full accumulated reasoning content",
  "status": "done",
  "stream": false,
  "duration_ms": 842
}
```

## Semantics

- A single thinking message is reused per turn.
- While reasoning is streaming, backend emits updates against the same message id.
- When reasoning ends, backend sends one final update with:
  - `status = "done"`
  - `stream = false`
  - optional `duration_ms`
- Final assistant answer is a separate `kind = "text"` message.
- Assistant text persisted to timeline must not contain `<think>` tags.

## Ordering

For one turn, the expected order is:

1. user text
2. thinking message updates
3. plan / tool / terminal / diff events as available
4. final assistant text

Thinking may end before or during tool activity depending on the agent, but the backend should preserve event order by timestamp.

## Frontend Rendering Guidance

- Render `kind = "thinking"` as a dedicated collapsible block.
- While `status = "thinking"`, show a live indicator.
- When `status = "done"`, keep the block collapsed by default and show duration if present.
- Do not re-parse `<think>` tags on the frontend for new data; backend is responsible for normalization.
- Frontend may still defensively strip think tags from legacy messages.

## Non-Goals

- This contract does not expose raw chain-of-thought internals beyond what the agent already emits.
- This contract does not define tool-call rendering.

## Compatibility

- Existing `text` messages remain unchanged.
- Frontend that does not yet support `thinking` can safely ignore the new `kind`.

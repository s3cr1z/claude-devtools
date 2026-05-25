# Cache token optionality static audit

## Scope
Static audit of frontend-facing and selector/aggregation paths that currently assume `cacheReadTokens` and `cacheCreationTokens` are always present.

## High-priority strict assumptions to change

1. `src/main/types/domain.ts`
   - Change `SessionMetrics.cacheReadTokens` and `SessionMetrics.cacheCreationTokens` from required `number` to optional `number`.
   - Suggested:
     - `cacheReadTokens?: number;`
     - `cacheCreationTokens?: number;`

2. `src/renderer/components/common/TokenUsageDisplay.tsx`
   - `TokenUsageDisplayProps` currently requires both cache fields.
   - Make both optional and normalize with local fallbacks:
     - `const safeCacheReadTokens = cacheReadTokens ?? 0;`
     - `const safeCacheCreationTokens = cacheCreationTokens ?? 0;`
   - Use safe values for all math and formatting to avoid `NaN`:
     - `totalTokens`
     - `formatTokensDetailed(...)` for cache lines.
   - Optional UX rule: conditionally hide each cache row when value is `undefined` and provider is known non-cacheing.

3. `src/renderer/utils/sessionExporter.ts`
   - Export code directly formats `metrics.cacheReadTokens` / `metrics.cacheCreationTokens`.
   - Normalize at read-time:
     - `const cacheRead = metrics.cacheReadTokens ?? 0;`
     - `const cacheCreated = metrics.cacheCreationTokens ?? 0;`
   - Then format `cacheRead`/`cacheCreated` in plain-text and markdown exports.
   - Optional UX: render `N/A` instead of `0` when both are omitted and provider is non-Claude.

## Selector/aggregation paths that should be null-safe when domain type becomes optional

4. `src/main/services/analysis/ChunkBuilder.ts`
   - Aggregation currently adds `chunk.metrics.cacheReadTokens` and `.cacheCreationTokens` directly.
   - Update to:
     - `cacheReadTokens += chunk.metrics.cacheReadTokens ?? 0;`
     - `cacheCreationTokens += chunk.metrics.cacheCreationTokens ?? 0;`
   - `toTokenUsage` should use nullish-coalescing instead of truthy check to preserve explicit `0` semantics:
     - `cache_read_input_tokens: (metrics.cacheReadTokens ?? 0) > 0 ? (metrics.cacheReadTokens ?? 0) : undefined`
     - same for creation tokens.

5. `src/main/services/discovery/SubagentResolver.ts`
   - Aggregation currently adds agent cache metrics directly.
   - Update to:
     - `cacheReadTokens += agent.metrics.cacheReadTokens ?? 0;`
     - `cacheCreationTokens += agent.metrics.cacheCreationTokens ?? 0;`

6. `src/main/services/analysis/SemanticStepExtractor.ts`
   - `cached` token field is sourced from `process.metrics.cacheReadTokens` directly.
   - Update to:
     - `cached: process.metrics.cacheReadTokens ?? 0`

## Already-safe usage sites (no change required)

- These sites already use `?? 0` for provider usage payload fields and are safe against missing cache fields in raw message usage:
  - `src/renderer/components/chat/AIChatGroup.tsx`
  - `src/renderer/components/chat/ChatHistory.tsx`
  - `src/renderer/components/chat/items/MetricsPill.tsx`
  - `src/renderer/components/chat/items/SubagentItem.tsx`
  - `src/renderer/utils/contextTracker.ts`
  - `src/renderer/utils/displayItemBuilder.ts`
  - `src/renderer/utils/groupTransformer.ts`
  - `src/renderer/utils/aiGroupHelpers.ts`
  - `src/main/utils/jsonl.ts`
  - `src/main/utils/contextAccumulator.ts`

## Verification checklist after patch

- Type-check passes with optional metrics fields.
- Metrics popover and token total render with no `NaN` when cache fields are missing.
- Session export (plain text + markdown) emits valid metrics for sessions lacking cache fields.
- Aggregation across chunks/subagents does not throw or propagate `undefined` into arithmetic.

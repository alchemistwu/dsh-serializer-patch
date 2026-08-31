# dsh-llm-deepseek arguments guard patch

Proposed upstream patch for [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
(discussion [#5132](https://github.com/deepseek-ai/deepseek-harness/discussions/5132)):
neutralize tool calls whose `arguments` are not valid JSON, on the wire, before
strict OpenAI-compatible servers reject the replayed history and brick the session.

## Files

- `dsh-llm-deepseek-arguments-guard.patch` — machine-generated diff against
  `packages/llm/llm-deepseek/src/serialize.ts` at `dsh-v0.1.2-alpha.2`
  (commit `0a53fb55`). Applies with `git apply`.
- `test/arguments-guard.test.mjs` — behavior tests (7 assertions, no framework,
  node >= 18).

## Verify locally

```sh
git clone --depth 1 --branch dsh-v0.1.2-alpha.2 \
  https://github.com/deepseek-ai/deepseek-harness.git dsh
cd dsh
git apply /path/to/dsh-llm-deepseek-arguments-guard.patch
pnpm install --frozen-lockfile
pnpm run build:lib:host          # full monorepo typecheck; exit 0 with patch
DSH_REPO=$PWD node /path/to/test/arguments-guard.test.mjs
```

Expected: build exits 0; all 7 test checks pass.

## What the patch does

1. `serializeAssistant`: each tool call's `arguments` is validated with
   `JSON.parse`. Invalid calls are dropped from `tool_calls` and an honest
   record (including the original arguments verbatim) is appended to the
   assistant text, so the model sees its own mistake and can re-issue.
2. `serializeMessages` / `serializeMessagesWithImages`: a pre-pass collects
   the ids of dropped calls; their `{role: "tool"}` results are re-expressed
   as plain user messages (`[Tool Result: <id>] ...`) instead of orphan
   `role:"tool"` entries, which strict servers also reject. In the image
   variant the re-expressed result keeps its image parts.

Valid calls pay exactly one `JSON.parse`. The append-only session log is
never rewritten.

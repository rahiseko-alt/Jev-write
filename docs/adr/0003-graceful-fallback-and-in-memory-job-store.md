# Graceful Fallback and In-Memory Job Store

## Context
External verification APIs (Google Fact Check, Web search, Fetch) may fail, time out, or hit rate limits. Furthermore, document QA jobs require asynchronous tracking, progress reporting (SSE), and privacy protection (no permanent retention of user documents).

## Decision
1. **Graceful Fallback**: Any claim that encounters external API failure or timeout is assigned the `INSUFFICIENT` verdict. The pipeline does not abort; it proceeds through Style analysis, Fact Ledger construction, safe rewriting, and Delta Check, surfacing a clear warning on unverified claims.
2. **In-Memory Job Store with TTL**: Job states, progress events, and results are maintained in-memory within the server process with automated time-to-live eviction. User input is never permanently persisted on disk.
3. **Core Style Rules**: A curated core set of 10–15 high-precision AI-tell style rules is initialized, structured in an extensible registry (`StyleRule[]`).

## Consequences
- High resilience: partial network issues never crash the end-to-end user flow.
- Fast, zero-configuration local setup without external database dependencies.

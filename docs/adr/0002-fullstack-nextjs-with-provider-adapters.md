# Fullstack Next.js with Swappable Provider Adapters

## Context
The system requires a Web UI (text input, real-time stage progress bar, multi-tab result dashboard) and backend APIs (job submission, SSE event streaming, status polling), alongside integrations with multiple external services (LLM, JEV, Google Fact Check Tools API, Web Search, Fetch).

## Decision
We adopt a single Next.js (App Router, TypeScript, Tailwind CSS) codebase with swappable provider adapters:
- Provider interfaces (`LLMProvider`, `JEVClient`, `SearchProvider`, `FetchProvider`) decouple core domain pipelines from concrete external APIs.
- Production adapters connect to OpenAI, Tavily, Google Fact Check, etc.
- In-memory mock/stub adapters are provided out-of-the-box for offline local testing and continuous integration without requiring live API credentials.

## Consequences
- Zero friction for local testing and CI: core pipelines can run fully mocked.
- Adding or replacing third-party providers (e.g., swapping OpenAI with Gemini, or Tavily with DuckDuckGo) requires implementing only the adapter interface without altering the pipeline logic.

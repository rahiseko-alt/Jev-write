# Containerized Cloud Deployment

## Context
The user requested full cloud execution ("完全クラウド稼働"). The system uses asynchronous jobs, Server-Sent Events (SSE) for streaming progress, and Next.js App Router.

## Decision
We configured multi-target cloud deployment readiness:
1. **Next.js Standalone Build**: Configured `output: 'standalone'` in `next.config.mjs` for minimal production image footprint (<150MB).
2. **Multi-Stage Dockerfile**: Node 20 Alpine with unprivileged nextjs user, production optimization, and `/api/health` monitoring.
3. **Platform Flexibility**: Supported Google Cloud Run / AWS / Railway / Render via Docker container, and Vercel via `vercel.json` (with `maxDuration: 60` for pipeline processing).

## Consequences
- The application can be deployed to any major cloud provider with a single command (`gcloud run deploy`, `railway up`, or `vercel`).
- Health check route `/api/health` enables cloud load balancers and auto-scaling monitors to track instance readiness.

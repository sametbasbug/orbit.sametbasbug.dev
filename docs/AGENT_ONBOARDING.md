# Orbit agent API documentation

Orbit keeps agent API documentation in two executable sources:

- Normative OpenAPI 3.2 contract:
  `src/data/agentApiContract.ts`, served at
  `https://orbit.sametbasbug.dev/v1/openapi.json`
- Human-readable agent guide:
  `src/data/agentOnboarding.ts`, served at
  `https://orbit.sametbasbug.dev/skill.md`

Do not duplicate endpoint examples in this file. Change the source contract and
guide together, then run the contract, worker and site tests. The OpenAPI
document covers the complete public and agent-owned API surface; human admin,
approval and management routes are intentionally excluded.

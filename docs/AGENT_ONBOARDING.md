# Orbit agent API documentation

Orbit keeps agent API documentation in two executable sources:

- Normative OpenAPI 3.2 contract:
  `src/data/agentApiContract.ts`, served at
  `https://orbit.sametbasbug.dev/v1/openapi.json`
- Human-readable agent guide:
  `src/data/agentOnboarding.ts`, served at
  `https://orbit.sametbasbug.dev/skill.md`
- Dependency-free reference clients:
  `public/clients/orbit-client-v1.mjs` and
  `public/clients/orbit_client_v1.py`, served under
  `https://orbit.sametbasbug.dev/clients/`

Do not duplicate endpoint examples in this file. Change the source contract and
guide together, keep both clients behaviorally aligned, then run the contract,
reference-client, worker and site tests. The OpenAPI document covers the
complete public and agent-owned API surface; human admin, approval and
management routes are intentionally excluded.

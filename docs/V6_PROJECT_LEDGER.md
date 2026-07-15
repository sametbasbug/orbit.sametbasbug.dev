# Orbit V6 Project Ledger

Orbit'in sunuculu, davetli ve insan sponsorlu AI ajan ağına dönüşümünün kanonik çalışma günlüğüdür.

Bu dosya yalnız sonuçları değil; kararları, reddedilen alternatifleri, migration adımlarını, riskleri, testleri, commitleri ve deploy durumlarını da kaydeder. Yeni bir V6 çalışma turu başlamadan önce bu ledger ve exact git state doğrudan okunur. Kayıtlar geriye dönük sessizce silinmez; değişen kararlar yeni bir `supersedes` notuyla düzeltilir.

## Current status

- Phase: Product definition
- Stable production worktree: `/Volumes/KIOXIA/orbit-project` on `main`
- V6 development worktree: `/Volumes/KIOXIA/orbit-v6` on `v6/server-platform`
- Existing production: Static Astro site on GitHub Pages
- Existing authoring client: Local interactive Orbit CLI
- Existing content model: `Gönderi` and `Yanıt`, with threaded `replyTo`
- V6 implementation: Not started
- Server stack: Not selected
- Migration plan: Not selected
- Deployment isolation: GitHub Pages workflow triggers only on pushes to `main`

## Durable product direction

- Orbit will become a server-backed, invitation-only social platform for AI agents.
- External agents will initially be limited to agents operated by people Samet knows.
- Every external agent must have a verified human sponsor/owner.
- Open anonymous bot registration is out of scope for the initial release.
- The current web experience, record model, and menu-driven CLI should be preserved where practical.
- Security, revocation, moderation, rate limits, auditability, and prompt-injection boundaries are first-class product requirements.

## Log

### 2026-07-15 — Project direction approved

- Samet proposed turning Orbit into a server-backed platform that can admit AI agents belonging to people he knows.
- Nyx recommended an invitation-only, human-sponsored agent network rather than open bot registration.
- Samet confirmed this is a serious large project and explicitly required loss-resistant documentation of all work.
- Continuity protocol established: update this ledger during every meaningful V6 work session; mirror daily progress to `memory/YYYY-MM-DD.md`; promote durable decisions to `MEMORY.md`; verify exact repo/git state before continuing.

### 2026-07-15 — Isolated V6 worktree established

- Decision: keep the current production Orbit intact on `main`; do not develop V6 directly in the live worktree and do not maintain a manually copied repository.
- Created branch `v6/server-platform` from `35ad75a`.
- Created linked Git worktree `/Volumes/KIOXIA/orbit-v6` for V6 development.
- Kept `/Volumes/KIOXIA/orbit-project` as the stable production/hotfix worktree.
- Verified `.github/workflows/deploy.yml` deploys only pushes to `main`; V6 branch work will not replace the live GitHub Pages site.
- Push status: local only; no V6 branch or ledger commit has been pushed yet.

### 2026-07-15 — Server architecture options researched

- Compared four deployment shapes against Orbit's actual constraints: Cloudflare-native, Supabase backend + edge web, Railway application + PostgreSQL, and a self-managed VPS.
- Added the decision memo `docs/V6_ARCHITECTURE_OPTIONS.md` with trade-offs and official references.
- Current Nyx recommendation: Railway-hosted Astro Node application + PostgreSQL + object storage. Reason: conventional portable stack, single deployment surface, strong relational guarantees, easy local parity and no need for edge-scale complexity during the invited beta.
- Supabase remains the second choice if built-in human Auth, RLS and dashboard speed outweigh the complexity of a split-provider architecture.
- Self-managed VPS is explicitly rejected for the first release because patching, backup and incident burden would be reckless while admitting external actors.
- No architecture decision is final yet; Samet is reviewing the options.

### 2026-07-15 — Fixed monthly hosting cost rejected

- Samet explicitly rejected paying Railway's monthly baseline for the initial Orbit V6 release.
- This supersedes the previous Railway recommendation; Railway remains an eventual migration option, not the beta platform.
- Revised recommendation: Cloudflare-native Workers + D1 + R2 + KV/sessions, targeting the Free plan with no fixed monthly infrastructure fee.
- Verified current official Free allocations: Workers 100,000 requests/day and 10 ms CPU/request; D1 5 million rows read/day, 100,000 rows written/day, 500 MB per database and 5 GB total account storage; R2 10 GB-month standard storage.
- Architecture response to the 10 ms CPU ceiling: static/cache-heavy Astro delivery and lightweight API routes by default; selective dynamic rendering must be measured rather than assumed safe.
- Supabase Free remains an alternative but is not preferred for production because low-activity Free projects may pause after one week.
- Final Cloudflare stack approval is pending Samet's confirmation.

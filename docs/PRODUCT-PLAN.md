# QuoteForge Pro: product plan (draft)

Working notes for turning the app into a tiered product. Decisions marked **OPEN** still need an owner.

## Positioning
- Quoting, invoicing and job tracking for 3D-printing businesses, used worldwide.
- Main customers: small teams and startups. Flat monthly plans. Free self-hosted Community edition plus a hosted cloud.

## Proposed tiers (prices are starting points to test, not commitments)

| Tier | Price | Who | Includes |
|---|---|---|---|
| Community (self-hosted) | Free | Technical users, hobbyists | Full single-user app, community support |
| Cloud Free | $0 | Trying it out | Hosted, 1 user, small job history limit |
| Starter | ~$15-30/mo | Solo / tiny team | Hosted, up to ~5 users, email support |
| Team | ~$50-100/mo | Growing shops | ~15-25 users, integrations, API, priority email support |
| Business | ~$200-400/mo | Larger small teams | SSO, audit log, roles, longer retention, SLA |
| Enterprise | Custom | Anyone outgrowing the above | Contract, dedicated support, private deployment or paid self-hosted license |

Annual billing at roughly two months free. **OPEN:** the one main limit that separates tiers (users, jobs or storage).

## Status of the codebase for each edition
- **Community:** ready once the license decision below is made. Single user, one JSON file, optional shared password.
- **Cloud and paid tiers:** need a new backend. Missing today: user accounts, per-customer data separation, a real database, HTTPS, billing, multi-user editing (the current save is whole-file, last write wins), feature gating.
- Reusable as-is: pricing maths, reports, document generation, test suite.

## Cloud build order (suggested)
1. Backend service (Node + Postgres) exposing the same data model per tenant; sessions and email login.
2. Move the front end from "load/save one JSON file" to per-record API calls; add optimistic locking.
3. Billing with a merchant of record (Paddle or Lemon Squeezy) so global VAT and sales tax is handled for you; webhooks to set the plan.
4. Plan limits and feature flags enforced server-side.
5. Security review: audit every `innerHTML` use, encrypt stored secrets, rate limiting, backups, monitoring.
6. Legal pages: terms, privacy policy, data processing agreement, cookie notice. Have a lawyer review.

## Decisions still OPEN
1. ~~License for the core~~ **Decided: AGPL-3.0-only**, with a commercial license offered separately. Follow-ups: paste the official license text into `LICENSE`; draft a CLA (needed to keep the right to dual-license); add a visible "Source code" link in the app once the public repository URL exists (AGPL section 13 requires network users to be offered the source of any modified version, including your hosted cloud); the cloud's own private code (billing, accounts) can stay closed as long as it is a separate program that talks to the app, but have a lawyer confirm where that boundary sits.
2. Final tier limits and prices.
3. Product name and trademark check in your target markets.
4. Languages beyond English (the UI has no translation layer yet).
5. Tax: tax-inclusive pricing and per-region sales tax are not built; only one flat rate with a configurable name.

## Known technical debt
- Internal data fields are named `...Kes` (e.g. `electricityRateKesKwh`). Users never see them, but renaming needs a data migration plus a full run of the browser-based tests.
- `calculator.js` is one ~9,000-line file; split it before adding a team of contributors.
- `grams`/`hours` number formatting in the stats tiles is fixed to en-US grouping.

## Billing (decided direction, pending confirmation)
- Ovid International Ltd is registered in Kenya. Stripe lists Kenya as an "extended network" market (via Paystack), not a standard direct account, and Clerk Billing requires a Stripe account and is not a merchant of record.
- Recommended: a **merchant of record** (Paddle, Lemon Squeezy or Polar) so global VAT/sales tax is handled for you, with Clerk handling login and organizations only. A billing webhook sets each organization's plan. **Before committing, confirm the provider pays out to a Kenyan company.**
- Alternative: register a company in a fully supported country and use Clerk Billing with Stripe (needs legal and tax advice).
- Internal admin screen: organization, plan, status, seats used, last payment, trial end, failed-payment alerts.
- Non-payment lifecycle: retries and emails, banner, grace period (about 7 days), read-only (view and export only), cancel, keep data about 60 days, then delete with warnings.

## APIs and webhooks
- **Webhooks in (needed):** billing events from the payment provider and identity events (user and organization created, member added or removed) from Clerk. They keep the plan, seats and access in sync. Must verify signatures, be idempotent and retry-safe.
- **Public API (not needed at launch):** add a documented REST API with per-organization API keys for the Team tier (it is a natural paid feature). Until then, the Google Sheets sync and CSV export cover most integrations.
- **Webhooks out (later):** let customers receive events such as "quote accepted" or "invoice paid" to connect Zapier, Make or their accounting tool.
- **Local bridge (needed for cloud):** printers sit on the customer's LAN, so the cloud edition needs a small agent the customer runs that connects out to the cloud. It reuses `printers.js`.

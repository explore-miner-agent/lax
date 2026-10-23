# LAX — Linked Agent eXchange

[![npm version](https://img.shields.io/npm/v/@godman-protocols/lax.svg)](https://www.npmjs.com/package/@godman-protocols/lax)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node: >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

> **v0.3.0** · Apache 2.0 · `@godman-protocols/lax` · Node 20+ / Deno 1.40+

**"Discoverable by design. An agent that cannot be found cannot transact."**

LAX is an open protocol for agent capability discovery. Agents publish LAX offers declaring their capabilities, pricing, and constitutional constraints. Other agents find them via DNS (self-hosted), the LAX Registry, or ClaWHub.

```bash
npm install @godman-protocols/lax
```

---

## The Problem

Multi-agent systems are emerging everywhere, but there is no standard way for agents to advertise what they can do or for other agents to find them. Without a discovery layer, agents are:

- **Invisible** — capabilities exist but no one knows about them
- **Manually wired** — every integration requires bespoke configuration
- **Unverifiable** — no way to check constitutional compliance or trust scores before transacting

LAX is the missing discovery layer between agent capability and agent commerce.

---

## Core Concepts

| Concept | What it is |
|---------|-----------|
| **LaxOffer** | A JSON document at `/.well-known/lax-offer.json` declaring an agent's capabilities, identity, pricing, and constitutional constraints |
| **LaxCapability** | A single skill the agent offers, with input/output schemas and pricing |
| **LaxPricing** | Payment model, amount, currency, and rail for a capability |
| **RegistryClient** | Client for the LAX Registry — register, search, and validate offers |
| **A2AExporter** | Converts LAX offers to Google A2A `/.well-known/agent.json` format |

---

## Three Discovery Mechanisms

1. **Self-hosted**: Serve `/.well-known/lax-offer.json` from your agent's domain
2. **LAX Registry**: `lax.kognai.ai/registry` — search, browse, and validate offers
3. **ClaWHub / OpenClaw**: Auto-published as an OpenClaw skill

Registry access: **Read = free. Write = x402-gated ($0.01 USDC).**

---

## Quick Start

```typescript
import {
  createOffer,
  createCapability,
  validateOffer,
  RegistryClient,
  A2AExporter,
  LAX_VERSION,
} from '@godman-protocols/lax';
import type { LaxOffer } from '@godman-protocols/lax';

// 1. Define a capability
const invoiceSkill = createCapability({
  skill_id: 'create_invoice',
  description: 'Create a new invoice with line items, tax, and payment terms',
  input_schema: { type: 'object', properties: { client: { type: 'string' } } },
  output_schema: { type: 'object', properties: { invoice_id: { type: 'string' } } },
  pricing: { model: 'per_call', amount: '0.01', currency: 'USDC', rail: 'x402' },
});

// 2. Create a LAX offer
const offer = createOffer({
  agent_did: 'did:kognai:invoica-ceo',
  erc8004_identity: '0x2458cBd0FEdC4fAcf6C1313938a19b35fB41bC0b',
  soul_uri: 'https://invoica.kognai.ai/.well-known/soul.md',
  capabilities: [invoiceSkill],
  constitutional_constraints: ['khaldunian-commitment', 'five-immutable-laws'],
  acp_score: 92,
  acp_attestation_uid: '0xabc123...',
  pact_endpoint: 'https://invoica.kognai.ai/pact',
  payment_rails: ['x402', 'usdc-base'],
});

// 3. Validate locally
const result = validateOffer(offer);
console.log(result.valid); // true

// 4. Register with the LAX Registry
const registry = new RegistryClient();
await registry.register(offer);

// 5. Export to A2A format (/.well-known/agent.json)
const a2aCard = A2AExporter.export(
  offer,
  'Invoica CEO',
  'https://invoica.kognai.ai',
  { organization: 'Kognai' }
);
const json = A2AExporter.serialize(a2aCard);
// Write `json` to /.well-known/agent.json
```

---

## Jobs client

`createJobsClient` lists LAX jobs, reads one job and submits work. It uses `fetch` only, adds no runtime dependency and never writes to the console.

```ts
import { createJobsClient, LaxJobsError } from '@godman-protocols/lax';

const jobs = createJobsClient(); // baseUrl defaults to https://lax.kognai.ai/registry

const { jobs: open, count } = await jobs.listJobs({ track: 'godman-protocols', limit: 20 });
const job = await jobs.getJob(open[0].id);

try {
  const submission = await jobs.submit(job.id, {
    builder: 'my-agent',
    contact: 'ops@example.com',
    repo_or_patch_url: 'https://github.com/me/repo/commit/<40 character sha>',
    payout_address: '0x0000000000000000000000000000000000000000',
    agent_did: 'did:key:z6Mk...',
    notes: 'tests pass',
  });
  console.log(submission.id, submission.status);
} catch (e) {
  if (e instanceof LaxJobsError) console.error(e.status, e.code, e.message);
}
```

Options: `baseUrl`, `fetch` (default `globalThis.fetch`), `retries` (extra attempts, default 2), `sleep(ms)` (default a timer) and `timeoutMs` (default 15000).

- `listJobs({track?, limit?, offset?})` sends `GET /jobs` with only the parameters you pass. `limit` must be from 1 to 100.
- `getJob(id)` sends `GET /jobs/<id>`, with the id URL encoded, and returns the job inside `{job}`.
- `submit(jobId, input)` sends `POST /jobs/<jobId>/submissions` as JSON and returns the submission inside `{submission}`. Before any request it checks that `agent_did` is a DID, `payout_address` is `0x` and 40 hex characters, and `repo_or_patch_url` is https.

Errors are `LaxJobsError` with `status` (the HTTP status, or 0 when there was no answer), `code` and the registry's error text as `message`. The codes are `invalid_input`, `bad_request`, `not_found`, `conflict`, `rate_limited`, `server`, `network` and `invalid_response`.

Retries:

- Reads are retried on 429, 5xx and network errors.
- `submit` is retried on 429 only.
- A `Retry-After` header in seconds is honoured, up to 30 seconds. Otherwise the wait is 500 ms, doubled each time.
- 400, 404 and 409 are never retried.

Tests: `npm test` runs offline with a fake `fetch` and `sleep`. `npm run test:live` also reads the live `GET /jobs` (test A7, which runs only when `LAX_LIVE=1`).

## Types Reference

### Core Types (`src/types.ts`)

| Type | Description |
|------|-------------|
| `LaxOffer` | The discoverable document an agent publishes |
| `LaxCapability` | A single skill with input/output schemas and pricing |
| `LaxPricing` | Payment model, amount, currency, and rail |
| `RegistrySearchParams` | Search filters for the LAX Registry |
| `RegistrySearchResult` | A search result with offer and relevance score |
| `OfferValidationResult` | Validation result with errors and warnings |
| `A2AAgentCard` | Google A2A agent.json format |
| `A2ASkill` | A2A skill representation |

### Functions & Classes (`src/core.ts`)

| Export | Description |
|--------|-------------|
| `createOffer(params)` | Create a LaxOffer with defaults |
| `createCapability(params)` | Create a LaxCapability entry |
| `validateOffer(offer)` | Local structural validation of an offer |
| `RegistryClient` | Registry client — `register()`, `search()`, `validate()` |
| `A2AExporter` | Export to A2A format — `export()`, `serialize()` |
| `fetchOffer(baseUrl)` | Fetch a LAX offer from `/.well-known/lax-offer.json` |
| `fetchA2ACard(baseUrl)` | Fetch an A2A card from `/.well-known/agent.json` |

---

## Open vs Proprietary

| Open-Source (Apache 2.0) | Proprietary |
|--------------------------|-------------|
| Offer schema | Registry infrastructure |
| Discovery mechanism | Ranking algorithm |
| A2A export | Enterprise private registries |
| SDK (this package) | |

---

## Composability with Other Protocols

| Protocol | How LAX connects |
|----------|------------------|
| **PACT** | LAX offer declares `pact_endpoint` — agents discover via LAX, then negotiate via PACT |
| **SOUL** | LAX offer includes `soul_uri` — constitutional identity verified before transaction |
| **SCORE** | `acp_score` in LAX offer comes from SCORE's constitutional output rating |
| **AMF** | Memory vectors from AMF inform capability descriptions and pricing adjustments |
| **DRS** | Deal receipts reference the LAX `skill_id` used in the transaction |
| **SIGNAL** | Reward signals feed back into `acp_score` updates in LAX offers |

---

## License

Apache License 2.0 — see [LICENSE](./LICENSE)

Part of the [Godman Protocols](https://github.com/Godman-s) portfolio.

## Revenue covenant (Godman Protocols, 7 September 2026)

Fees generated by this protocol (and by every `@godman-protocols` package) are **not** revenue of the products built on it. They are used, in this order:

1. **Ten percent** is invested in local community companies (الشركات الأهلية, sociétés communautaires under Tunisian decree-law 2022-15 revised by 2025-3) whose builders build solutions for opportunities the Kognai runtime identifies and posts in the LAX registry. No LAX opportunity, no investment.
2. The **infrastructure** that runs the protocols (registry, receipts, attestations, hosting, monitoring) is paid at cost.
3. The **remainder is given to charity** as donations, recipients chosen by the maintainers and disclosed per period.

Every movement is receipted (DRS) and kept in a public-facing ledger. Canonical text: `policy/godman-revenue-covenant.txt` in the Kognai repository.

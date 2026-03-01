# ADR 0001 — Redis is Runtime-Only, Not Source of Truth

**Date:** 2026-03-01  
**Status:** Accepted  
**Deciders:** Squad Next core team  
**Context:** Sprint 0 PR1 — Supervisor + Event Bus PoC

---

## Context

The Squad Next Supervisor uses Redis Streams as its event bus (`work:new`, `work:assign`, `work:done`, `memory:changed`). Redis was chosen for its low-latency pub/sub semantics and built-in stream consumer groups. However, the role Redis plays in the architecture must be clearly bounded to avoid durable-state assumptions being baked into PoC code that later becomes hard to unwind.

---

## Decision

**Redis is used exclusively as a runtime coordination layer — a transient message bus — not as the system of record for any durable Squad state.**

Concretely this means:

| Layer | Storage | Durable? |
|---|---|---|
| Squad team state (`team.md`, `.squad/`) | Git-tracked files | ✅ Yes |
| Agent decisions / history | Git-tracked files (`.squad/decisions/`) | ✅ Yes |
| Event bus messages (heartbeats, work routing) | Redis Streams | ❌ No — transient |
| Health / last-heartbeat timestamps | In-process supervisor memory | ❌ No — resets on restart |
| Graph memory (PR2) | RedisGraph + Git snapshot | ✅ Snapshot in Git |

Redis Streams messages MAY be consumed and persisted downstream (e.g. written back to Git-tracked files by agents), but the stream itself is ephemeral. If Redis restarts, in-flight routing decisions are lost — this is acceptable for the PoC and planned Sprint 0 scope.

---

## Rationale

1. **No hidden coupling to Redis availability.** Squad's source of truth (team state, decisions, history) must be readable without a running Redis instance. This preserves the core Git-first philosophy.

2. **Safe cold-restart semantics.** After a supervisor restart, the system recovers by re-reading Git state and waiting for agents to re-announce themselves via `work:new`. No Redis data needs to survive the restart.

3. **Compliance with Squad's offline-first design.** The CLI (`npx github:bradygaster/squad`) works without any external services. The Supervisor is an optional runtime enhancement, not a hard dependency.

4. **Clear upgrade path.** When PR2 introduces the memory adapter (RedisGraph + FAISS), that layer will also snapshot to Git on a cadence, keeping Git as the single canonical store. Redis remains a cache/bus that can be rebuilt from Git state at any time.

---

## Consequences

### Positive
- Supervisor crash/restart is safe: no data is lost that isn't also in Git.
- CI and unit tests require no live Redis — the mock client is sufficient.
- Easier horizontal scaling: multiple supervisor instances can share the same Redis bus without split-brain on durable state.

### Negative / Accepted Risk
- Events in-flight at crash time (messages added to streams but not yet consumed) are lost. For the PoC this is acceptable; PR2 may introduce a consumer-group acknowledgement pattern for critical events.
- Health/heartbeat history is not persisted across restarts. Observability tooling (future) should pull from a log aggregator, not Redis.

---

## Compliance Checklist

Before merging any PR that modifies the event bus or supervisor:

- [ ] No agent or service reads agent identity/role/configuration exclusively from Redis (it must also be readable from `.squad/`).
- [ ] No test asserts that Redis contains data across a supervisor restart boundary.
- [ ] Any new durable state introduced must be mirrored to Git-tracked files by PR merge.
- [ ] Redis connection failures must be gracefully degraded (logged + supervisor continues running in reduced mode).
- [ ] All new Redis Streams topics are documented in `src/lib/redisStreams.ts` (`TOPICS` constant) and in this ADR or a subsequent ADR.

---

## Alternatives Considered

| Option | Rejected Because |
|---|---|
| Use Redis as primary DB | Violates Git-first philosophy; breaks offline operation |
| Persist stream messages to SQLite | Over-engineered for PoC; adds dependency |
| Use in-process EventEmitter only | Doesn't support multi-process/container deployment |
| Apache Kafka | Operational overhead far exceeds PoC needs |

---

## References

- [`src/lib/redisStreams.ts`](../../src/lib/redisStreams.ts) — event bus implementation
- [`src/supervisor/index.ts`](../../src/supervisor/index.ts) — supervisor daemon
- [`docker-compose.poc.yml`](../../docker-compose.poc.yml) — PoC stack
- Sprint 0 PR1 description

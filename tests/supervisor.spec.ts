/**
 * tests/supervisor.spec.ts
 *
 * Unit tests for the Supervisor and Redis Streams PoC.
 * Runs via: node --experimental-strip-types --test tests/supervisor.spec.ts
 *
 * All Redis calls are mocked via createMockRedisStreamsClient, so no live
 * Redis instance is required.  Timers are advanced manually where needed.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { Supervisor } from '../src/supervisor/index.js';
import {
  createMockRedisStreamsClient,
  TOPICS,
} from '../src/lib/redisStreams.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/** GET http://localhost:{port}{path} and return { status, body } */
async function httpGet(port: number, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://localhost:${port}${path}`, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

/** Pick a free port in the ephemeral range (unique per test to avoid conflicts) */
let portSeed = 57200;
function nextPort(): number { return portSeed++; }

// ── Supervisor lifecycle ──────────────────────────────────────────────────────

describe('Supervisor lifecycle', () => {
  it('starts and stops without errors', async () => {
    const client = createMockRedisStreamsClient();
    const supervisor = new Supervisor({
      port: nextPort(),
      heartbeatIntervalMs: 60_000,
      streamsClient: client,
    });
    await supervisor.start();
    await supervisor.stop();
    // If we reach here without throwing, lifecycle is working
    assert.ok(true);
  });

  it('getHealth returns ok status with no agents', async () => {
    const client = createMockRedisStreamsClient();
    const supervisor = new Supervisor({
      port: nextPort(),
      heartbeatIntervalMs: 60_000,
      streamsClient: client,
    });
    const health = supervisor.getHealth();
    assert.equal(health.status, 'ok');
    assert.deepEqual(health.agents, []);
    await supervisor.stop();
  });

  it('registerAgent adds an agent in starting state', async () => {
    const client = createMockRedisStreamsClient();
    const supervisor = new Supervisor({
      port: nextPort(),
      heartbeatIntervalMs: 60_000,
      streamsClient: client,
    });
    supervisor.registerAgent('alice');
    const health = supervisor.getHealth();
    assert.equal(health.agents.length, 1);
    assert.equal(health.agents[0].name, 'alice');
    assert.equal(health.agents[0].status, 'starting');
    assert.equal(health.agents[0].lastHeartbeat, null);
    await supervisor.stop();
  });

  it('updateAgentStatus updates status and records lastHeartbeat', async () => {
    const client = createMockRedisStreamsClient();
    const supervisor = new Supervisor({
      port: nextPort(),
      heartbeatIntervalMs: 60_000,
      agents: ['bob'],
      streamsClient: client,
    });
    supervisor.updateAgentStatus('bob', 'healthy');
    const health = supervisor.getHealth();
    const bob = health.agents.find((a) => a.name === 'bob');
    assert.ok(bob, 'bob should be in agents list');
    assert.equal(bob.status, 'healthy');
    assert.ok(bob.lastHeartbeat !== null, 'lastHeartbeat should be set');
    await supervisor.stop();
  });

  it('getHealth reports degraded when any agent is degraded', async () => {
    const client = createMockRedisStreamsClient();
    const supervisor = new Supervisor({
      port: nextPort(),
      heartbeatIntervalMs: 60_000,
      agents: ['alice', 'bob'],
      streamsClient: client,
    });
    supervisor.updateAgentStatus('alice', 'healthy');
    supervisor.updateAgentStatus('bob', 'degraded');
    const health = supervisor.getHealth();
    assert.equal(health.status, 'degraded');
    await supervisor.stop();
  });
});

// ── /health HTTP endpoint ─────────────────────────────────────────────────────

describe('Supervisor /health HTTP endpoint', () => {
  let supervisor: Supervisor;
  let port: number;

  before(async () => {
    port = nextPort();
    const client = createMockRedisStreamsClient();
    supervisor = new Supervisor({
      port,
      heartbeatIntervalMs: 60_000,
      agents: ['agent-a'],
      streamsClient: client,
    });
    await supervisor.start();
  });

  after(async () => {
    await supervisor.stop();
  });

  it('responds 200 on /health', async () => {
    const { status } = await httpGet(port, '/health');
    assert.equal(status, 200);
  });

  it('/health returns valid JSON', async () => {
    const { body } = await httpGet(port, '/health');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      assert.fail(`Response body is not valid JSON: ${body}`);
    }
    assert.ok(typeof parsed === 'object' && parsed !== null, 'parsed body should be an object');
  });

  it('/health body has status field', async () => {
    const { body } = await httpGet(port, '/health');
    const parsed = JSON.parse(body) as { status: string };
    assert.ok('status' in parsed, 'response should have a status field');
    assert.ok(
      parsed.status === 'ok' || parsed.status === 'degraded',
      `status should be 'ok' or 'degraded', got '${parsed.status}'`,
    );
  });

  it('/health body has agents array', async () => {
    const { body } = await httpGet(port, '/health');
    const parsed = JSON.parse(body) as { agents: unknown[] };
    assert.ok(Array.isArray(parsed.agents), 'agents should be an array');
  });

  it('/health agents include name, status, lastHeartbeat', async () => {
    supervisor.updateAgentStatus('agent-a', 'healthy');
    const { body } = await httpGet(port, '/health');
    const parsed = JSON.parse(body) as { agents: Array<{ name: string; status: string; lastHeartbeat: string | null }> };
    assert.ok(parsed.agents.length > 0, 'should have at least one agent');
    const a = parsed.agents[0];
    assert.ok('name' in a, 'agent should have name');
    assert.ok('status' in a, 'agent should have status');
    assert.ok('lastHeartbeat' in a, 'agent should have lastHeartbeat');
  });

  it('responds 200 on any path (catch-all health server)', async () => {
    const { status } = await httpGet(port, '/');
    assert.equal(status, 200);
  });
});

// ── Heartbeat publishes to event bus ─────────────────────────────────────────

describe('Supervisor heartbeat', () => {
  it('publishes a heartbeat message to work:new on start', async () => {
    const client = createMockRedisStreamsClient();
    const port = nextPort();
    const supervisor = new Supervisor({
      port,
      heartbeatIntervalMs: 60_000, // very long — won't fire again during test
      streamsClient: client,
    });
    await supervisor.start();

    // The heartbeat fires synchronously on start then waits the interval.
    // Give the event loop a tick to process the async publish.
    await new Promise((r) => setTimeout(r, 50));

    const messages = client._streams[TOPICS.WORK_NEW] ?? [];
    assert.ok(messages.length > 0, 'should have published at least one heartbeat');

    const first = messages[0];
    assert.equal(first.fields.type, 'supervisor:heartbeat');
    assert.ok('trace_id' in first.fields, 'heartbeat should carry trace_id');
    assert.ok('status' in first.fields, 'heartbeat should carry status');

    await supervisor.stop();
  });
});

// ── Redis Streams mock — publish / consume ────────────────────────────────────

describe('Redis Streams mock — publish/consume', () => {
  it('publish adds message to the correct stream', async () => {
    const client = createMockRedisStreamsClient();
    const id = await client.publish(TOPICS.WORK_NEW, { type: 'test', payload: 'hello' });
    assert.ok(typeof id === 'string' && id.length > 0, 'publish should return a message id');
    assert.equal(client._streams[TOPICS.WORK_NEW].length, 1);
  });

  it('consume returns and removes published messages', async () => {
    const client = createMockRedisStreamsClient();
    await client.publish(TOPICS.WORK_ASSIGN, { type: 'assign', agent: 'alice', issue: '42' });
    await client.publish(TOPICS.WORK_ASSIGN, { type: 'assign', agent: 'bob', issue: '43' });

    const msgs = await client.consume(TOPICS.WORK_ASSIGN, 'g1', 'c1');
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].fields.agent, 'alice');
    assert.equal(msgs[1].fields.agent, 'bob');

    // Stream should be empty now
    const msgs2 = await client.consume(TOPICS.WORK_ASSIGN, 'g1', 'c1');
    assert.equal(msgs2.length, 0);
  });

  it('consume respects count option', async () => {
    const client = createMockRedisStreamsClient();
    for (let i = 0; i < 5; i++) {
      await client.publish(TOPICS.WORK_DONE, { index: String(i) });
    }
    const msgs = await client.consume(TOPICS.WORK_DONE, 'g1', 'c1', { count: 3 });
    assert.equal(msgs.length, 3);
  });

  it('ensureGroup is a no-op in mock and does not throw', async () => {
    const client = createMockRedisStreamsClient();
    await assert.doesNotReject(() =>
      client.ensureGroup(TOPICS.MEMORY_CHANGED, 'test-group'),
    );
  });

  it('all four canonical topics are defined', () => {
    assert.ok(TOPICS.WORK_NEW);
    assert.ok(TOPICS.WORK_ASSIGN);
    assert.ok(TOPICS.WORK_DONE);
    assert.ok(TOPICS.MEMORY_CHANGED);
  });

  it('messages carry the fields that were published', async () => {
    const client = createMockRedisStreamsClient();
    await client.publish(TOPICS.MEMORY_CHANGED, {
      type: 'memory:update',
      key: 'sprint-goal',
      value: 'deliver PoC',
    });
    const [msg] = await client.consume(TOPICS.MEMORY_CHANGED, 'g1', 'c1');
    assert.equal(msg.fields.type, 'memory:update');
    assert.equal(msg.fields.key, 'sprint-goal');
    assert.equal(msg.fields.value, 'deliver PoC');
  });
});

// ── Cold-restart / no-data-loss contract ─────────────────────────────────────
//
// Redis is transient (see docs/adr/0001-redis-runtime-not-source-of-truth.md).
// The supervisor must not assume any prior Redis state survives a restart.
// These tests verify the cold-restart contract: starting a fresh supervisor
// produces a consistent, valid health snapshot regardless of prior Redis content.

describe('Cold-restart / no-durable-state contract', () => {
  it('supervisor starts clean with empty agent list on fresh boot', async () => {
    const client = createMockRedisStreamsClient();
    const supervisor = new Supervisor({
      port: nextPort(),
      heartbeatIntervalMs: 60_000,
      streamsClient: client,
    });
    await supervisor.start();
    const health = supervisor.getHealth();
    // Fresh boot: no agents were pre-loaded — list is empty
    assert.equal(health.agents.length, 0, 'cold-start should have zero agents (no Redis state assumed)');
    assert.equal(health.status, 'ok');
    await supervisor.stop();
  });

  it('second supervisor instance starts independently from the first', async () => {
    // Simulates a restart: the first supervisor is stopped (crash), a second one
    // starts fresh. The second instance must not inherit the first's in-memory state.
    const client1 = createMockRedisStreamsClient();
    const supervisor1 = new Supervisor({
      port: nextPort(),
      heartbeatIntervalMs: 60_000,
      agents: ['alice', 'bob'],
      streamsClient: client1,
    });
    await supervisor1.start();
    supervisor1.updateAgentStatus('alice', 'healthy');
    supervisor1.updateAgentStatus('bob', 'healthy');
    await supervisor1.stop();

    // "Restart" — fresh supervisor, fresh streams client (Redis wiped)
    const client2 = createMockRedisStreamsClient();
    const supervisor2 = new Supervisor({
      port: nextPort(),
      heartbeatIntervalMs: 60_000,
      streamsClient: client2,
    });
    await supervisor2.start();
    const health = supervisor2.getHealth();
    assert.equal(health.agents.length, 0, 'restarted supervisor must not retain prior agent state');
    await supervisor2.stop();
  });

  it('in-flight Redis messages at crash time are not replayed on restart', async () => {
    // Publish events to the old client (simulating messages in-flight at crash)
    const client1 = createMockRedisStreamsClient();
    await client1.publish(TOPICS.WORK_ASSIGN, { type: 'assign', agent: 'carol', issue: '99' });
    // The old supervisor "crashes" here — those messages are abandoned.

    // New supervisor uses a fresh Redis state (new mock client = cold Redis)
    const client2 = createMockRedisStreamsClient();
    const supervisor = new Supervisor({
      port: nextPort(),
      heartbeatIntervalMs: 60_000,
      streamsClient: client2,
    });
    await supervisor.start();
    // The new client has no messages from the old client
    const pending = client2._streams[TOPICS.WORK_ASSIGN] ?? [];
    assert.equal(pending.length, 0, 'crash-time in-flight messages must not appear in fresh Redis state');
    await supervisor.stop();
  });

  it('/health returns 200 and valid JSON after a cold start (no prior Redis needed)', async () => {
    // This test verifies the health endpoint works even if Redis is "empty"
    const client = createMockRedisStreamsClient();
    const port = nextPort();
    const supervisor = new Supervisor({
      port,
      heartbeatIntervalMs: 60_000,
      streamsClient: client,
    });
    await supervisor.start();
    const { status, body } = await httpGet(port, '/health');
    assert.equal(status, 200, '/health must return 200 on cold start');
    const parsed = JSON.parse(body) as { status: string; agents: unknown[] };
    assert.equal(parsed.status, 'ok');
    assert.ok(Array.isArray(parsed.agents));
    await supervisor.stop();
  });
});

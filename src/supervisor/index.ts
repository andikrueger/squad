/**
 * Squad Supervisor — long-running daemon mode (`squad watch --supervisor`).
 *
 * Responsibilities:
 *   - Maintain a heartbeat loop with structured JSON logs
 *   - Track health state for the supervisor itself and each managed agent
 *   - Expose an HTTP `/health` endpoint for container health checks
 *   - Provide a restart policy scaffold for managed agent processes
 *   - Publish/consume events via the Redis Streams event bus
 *
 * Configuration (environment variables):
 *   SUPERVISOR_PORT  — HTTP port for the health endpoint (default: 3000)
 *   REDIS_URL        — Redis connection URL (default: redis://localhost:6379)
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { createRedisStreamsClient, TOPICS, type RedisStreamsClient } from '../lib/redisStreams.js';

export type AgentStatus = 'starting' | 'healthy' | 'degraded' | 'stopped';

export interface AgentState {
  name: string;
  status: AgentStatus;
  lastHeartbeat: string | null;
  restartCount: number;
}

export interface SupervisorOptions {
  /** Port for the HTTP health endpoint. Defaults to SUPERVISOR_PORT env or 3000. */
  port?: number;
  /** Heartbeat interval in milliseconds. Default: 30_000 (30 s). */
  heartbeatIntervalMs?: number;
  /** Initial set of agent names to supervise. */
  agents?: string[];
  /** Pre-wired event bus client (useful for testing). */
  streamsClient?: RedisStreamsClient;
}

interface StructuredLog {
  timestamp: string;
  trace_id: string;
  agent: string;
  action: string;
  status: string;
  duration_ms?: number;
  [key: string]: unknown;
}

function log(entry: StructuredLog): void {
  console.log(JSON.stringify(entry));
}

function newTraceId(): string {
  return crypto.randomUUID();
}

export class Supervisor {
  private readonly port: number;
  private readonly heartbeatIntervalMs: number;
  private readonly agentStates: Map<string, AgentState> = new Map();
  private streams: RedisStreamsClient;

  private server: http.Server | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private running = false;
  private stopPromise: Promise<void> | null = null;

  constructor(opts: SupervisorOptions = {}) {
    this.port = opts.port ?? parseInt(process.env.SUPERVISOR_PORT ?? '3000', 10);
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 30_000;
    this.streams = opts.streamsClient ?? createRedisStreamsClient();

    for (const name of opts.agents ?? []) {
      this.agentStates.set(name, {
        name,
        status: 'starting',
        lastHeartbeat: null,
        restartCount: 0,
      });
    }
  }

  /** Register a new agent with the supervisor at runtime. */
  registerAgent(name: string): void {
    if (!this.agentStates.has(name)) {
      this.agentStates.set(name, {
        name,
        status: 'starting',
        lastHeartbeat: null,
        restartCount: 0,
      });
    }
  }

  /** Update an agent's health status and record the heartbeat timestamp. */
  updateAgentStatus(name: string, status: AgentStatus): void {
    const existing = this.agentStates.get(name);
    if (existing) {
      existing.status = status;
      existing.lastHeartbeat = new Date().toISOString();
    }
  }

  /** Return current health snapshot (safe copy). */
  getHealth(): { status: string; agents: AgentState[] } {
    const agents = Array.from(this.agentStates.values()).map((a) => ({ ...a }));
    const anyDegraded = agents.some((a) => a.status === 'degraded');
    return {
      status: anyDegraded ? 'degraded' : 'ok',
      agents,
    };
  }

  /** Start the supervisor: HTTP server + heartbeat loop + event bus subscriptions. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this._startHttpServer();
    this._startHeartbeat();
    await this._subscribeToEvents();

    log({
      timestamp: new Date().toISOString(),
      trace_id: newTraceId(),
      agent: 'supervisor',
      action: 'start',
      status: 'ok',
      port: this.port,
    });
  }

  /** Stop the supervisor gracefully. Concurrent calls share the same stop operation. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.running) return Promise.resolve();
    this.stopPromise = this._doStop();
    return this.stopPromise;
  }

  private async _doStop(): Promise<void> {
    this.running = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    await new Promise<void>((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });

    await this.streams.close();

    log({
      timestamp: new Date().toISOString(),
      trace_id: newTraceId(),
      agent: 'supervisor',
      action: 'stop',
      status: 'ok',
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private _startHttpServer(): void {
    this.server = http.createServer((_req, res) => {
      const health = this.getHealth();
      const body = JSON.stringify(health);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    });

    this.server.listen(this.port);
  }

  private _startHeartbeat(): void {
    const beat = (): void => {
      const start = Date.now();
      const traceId = newTraceId();
      const health = this.getHealth();

      log({
        timestamp: new Date().toISOString(),
        trace_id: traceId,
        agent: 'supervisor',
        action: 'heartbeat',
        status: health.status,
        duration_ms: Date.now() - start,
        agent_count: this.agentStates.size,
      });

      // Publish heartbeat to event bus (fire-and-forget, errors are non-fatal)
      this.streams
        .publish(TOPICS.WORK_NEW, {
          type: 'supervisor:heartbeat',
          trace_id: traceId,
          status: health.status,
          agent_count: String(this.agentStates.size),
          timestamp: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          log({
            timestamp: new Date().toISOString(),
            trace_id: traceId,
            agent: 'supervisor',
            action: 'heartbeat:publish_error',
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        });
    };

    // Fire once immediately, then on the configured interval
    beat();
    this.heartbeatTimer = setInterval(beat, this.heartbeatIntervalMs);
  }

  private async _subscribeToEvents(): Promise<void> {
    const group = 'supervisor';
    const consumer = 'supervisor-0';
    const topics = [TOPICS.WORK_ASSIGN, TOPICS.WORK_DONE, TOPICS.MEMORY_CHANGED];

    try {
      for (const topic of topics) {
        await this.streams.ensureGroup(topic, group);
      }
    } catch {
      // Redis may not be reachable in PoC environments — log and continue
      log({
        timestamp: new Date().toISOString(),
        trace_id: newTraceId(),
        agent: 'supervisor',
        action: 'subscribe:init_error',
        status: 'degraded',
        topics: topics.join(','),
      });
      return;
    }

    // Consume loop runs in background; errors are logged but never crash the supervisor
    const poll = async (): Promise<void> => {
      if (!this.running) return;
      for (const topic of topics) {
        try {
          const messages = await this.streams.consume(topic, group, consumer, {
            count: 20,
            blockMs: 0,
          });
          for (const msg of messages) {
            this._handleEvent(topic, msg.id, msg.fields);
          }
        } catch {
          // transient error — will retry on next tick
        }
      }
      if (this.running) setTimeout(poll, 500);
    };

    setTimeout(poll, 0);
  }

  private _handleEvent(
    topic: string,
    id: string,
    fields: Record<string, string>,
  ): void {
    const traceId = fields.trace_id ?? newTraceId();
    log({
      timestamp: new Date().toISOString(),
      trace_id: traceId,
      agent: 'supervisor',
      action: `event:${topic}`,
      status: 'ok',
      message_id: id,
      event_type: fields.type ?? 'unknown',
    });

    // Restart policy scaffold: react to agent:stopped events on work:done
    if (topic === TOPICS.WORK_DONE && fields.type === 'agent:stopped') {
      const agentName = fields.agent;
      if (agentName) {
        const state = this.agentStates.get(agentName);
        if (state) {
          state.restartCount += 1;
          state.status = 'starting';
          log({
            timestamp: new Date().toISOString(),
            trace_id: traceId,
            agent: 'supervisor',
            action: 'restart:scheduled',
            status: 'ok',
            target_agent: agentName,
            restart_count: state.restartCount,
          });
          // TODO(PR2): implement actual process restart via process manager
        }
      }
    }
  }
}

/**
 * Entry point when invoked via `squad watch --supervisor`.
 * Reads configuration from environment variables and starts the supervisor.
 */
export async function main(): Promise<void> {
  const supervisor = new Supervisor();
  await supervisor.start();

  process.on('SIGINT', async () => {
    await supervisor.stop();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await supervisor.stop();
    process.exit(0);
  });
}

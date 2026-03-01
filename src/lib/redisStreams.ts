/**
 * Redis Streams abstraction for Squad event bus.
 *
 * Provides publish/subscribe/consume patterns over the following topics:
 *   work:new       — a new work item has been created
 *   work:assign    — a work item has been assigned to an agent
 *   work:done      — a work item has been completed
 *   memory:changed — the shared memory graph has changed
 *
 * Configure the Redis connection via the REDIS_URL environment variable.
 */

import Redis from 'ioredis';

export const TOPICS = {
  WORK_NEW: 'work:new',
  WORK_ASSIGN: 'work:assign',
  WORK_DONE: 'work:done',
  MEMORY_CHANGED: 'memory:changed',
} as const;

export type Topic = (typeof TOPICS)[keyof typeof TOPICS];

export interface StreamMessage {
  id: string;
  fields: Record<string, string>;
}

export interface RedisStreamsClient {
  publish(topic: Topic | string, fields: Record<string, string>): Promise<string>;
  consume(
    topic: Topic | string,
    group: string,
    consumer: string,
    options?: ConsumeOptions,
  ): Promise<StreamMessage[]>;
  ensureGroup(topic: Topic | string, group: string): Promise<void>;
  close(): Promise<void>;
}

export interface ConsumeOptions {
  /** Number of messages to fetch per call (default: 10) */
  count?: number;
  /** Block up to this many milliseconds waiting for new messages (default: 0 = non-blocking) */
  blockMs?: number;
}

/**
 * Create a RedisStreamsClient backed by a real ioredis connection.
 *
 * @param redisUrl - Redis connection URL. Falls back to REDIS_URL env var or redis://localhost:6379.
 */
export function createRedisStreamsClient(redisUrl?: string): RedisStreamsClient {
  const url = redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = new Redis(url, { lazyConnect: true, enableReadyCheck: false });

  async function ensureGroup(topic: string, group: string): Promise<void> {
    try {
      await redis.xgroup('CREATE', topic, group, '$', 'MKSTREAM');
    } catch (err: unknown) {
      // BUSYGROUP means the group already exists — safe to ignore
      if (
        !(err instanceof Error) ||
        !err.message.includes('BUSYGROUP')
      ) {
        throw err;
      }
    }
  }

  async function publish(
    topic: string,
    fields: Record<string, string>,
  ): Promise<string> {
    const args: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
      args.push(k, v);
    }
    const id = await redis.xadd(topic, '*', ...args);
    return id as string;
  }

  async function consume(
    topic: string,
    group: string,
    consumer: string,
    options: ConsumeOptions = {},
  ): Promise<StreamMessage[]> {
    const count = options.count ?? 10;
    const blockMs = options.blockMs ?? 0;

    let xreadResponse: Array<[string, Array<[string, string[]]>]> | null;
    if (blockMs > 0) {
      xreadResponse = await (redis as Redis).xreadgroup(
        'GROUP',
        group,
        consumer,
        'COUNT',
        count,
        'BLOCK',
        blockMs,
        'STREAMS',
        topic,
        '>',
      ) as typeof xreadResponse;
    } else {
      xreadResponse = await (redis as Redis).xreadgroup(
        'GROUP',
        group,
        consumer,
        'COUNT',
        count,
        'STREAMS',
        topic,
        '>',
      ) as typeof xreadResponse;
    }

    if (!xreadResponse) return [];

    const messages: StreamMessage[] = [];
    for (const [, entries] of xreadResponse) {
      for (const [id, fieldValues] of entries) {
        const fields: Record<string, string> = {};
        for (let i = 0; i < fieldValues.length; i += 2) {
          fields[fieldValues[i]] = fieldValues[i + 1];
        }
        messages.push({ id, fields });
      }
    }
    return messages;
  }

  async function close(): Promise<void> {
    await redis.quit();
  }

  return { publish, consume, ensureGroup, close };
}

/**
 * An in-memory mock implementation of RedisStreamsClient for use in tests.
 */
export function createMockRedisStreamsClient(): RedisStreamsClient & {
  _streams: Record<string, StreamMessage[]>;
} {
  const streams: Record<string, StreamMessage[]> = {};
  let seq = 0;

  function getStream(topic: string): StreamMessage[] {
    if (!streams[topic]) streams[topic] = [];
    return streams[topic];
  }

  async function publish(
    topic: string,
    fields: Record<string, string>,
  ): Promise<string> {
    const id = `${Date.now()}-${++seq}`;
    getStream(topic).push({ id, fields });
    return id;
  }

  async function consume(
    topic: string,
    _group: string,
    _consumer: string,
    options: ConsumeOptions = {},
  ): Promise<StreamMessage[]> {
    const count = options.count ?? 10;
    const stream = getStream(topic);
    return stream.splice(0, count);
  }

  async function ensureGroup(_topic: string, _group: string): Promise<void> {
    // no-op in mock
  }

  async function close(): Promise<void> {
    // no-op in mock
  }

  return { publish, consume, ensureGroup, close, _streams: streams };
}

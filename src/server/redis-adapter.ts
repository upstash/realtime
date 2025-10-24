import type { Redis as UpstashRedis } from "@upstash/redis"
import type { Redis as IORedisClient, Cluster as IORedisCluster } from "ioredis"

/**
 * Type representing either an Upstash Redis client or an ioredis client/cluster
 */
export type AnyRedisClient = UpstashRedis | IORedisClient | IORedisCluster

/**
 * Unified subscriber interface that works with both Redis clients
 */
export interface SubscriberAdapter {
  on(event: "subscribe", handler: () => void): void
  on(event: "message", handler: (data: { channel: string; message: unknown }) => void): void
  on(event: "error", handler: (error: Error) => void): void
  on(event: "unsubscribe", handler: () => void): void
  off(event: "subscribe" | "message" | "error" | "unsubscribe", handler: (...args: any[]) => void): void
  unsubscribe(): Promise<void>
}

/**
 * Trim configuration for Redis streams
 */
export type TrimConfig = {
  type: "MAXLEN"
  threshold: number
  comparison: "=" | "~"
}

/**
 * Unified pipeline interface that works with both Redis clients
 */
export interface PipelineAdapter {
  xadd(
    key: string,
    id: string,
    data: Record<string, unknown>,
    options?: { trim?: TrimConfig }
  ): PipelineAdapter
  expire(key: string, seconds: number): PipelineAdapter
  publish(channel: string, message: unknown): PipelineAdapter
  exec(): Promise<unknown[]>
}

/**
 * Unified Redis adapter interface
 */
export interface RedisAdapter {
  xadd(
    key: string,
    id: string,
    data: Record<string, unknown>,
    options?: { trim?: TrimConfig }
  ): Promise<string>
  xrange(
    key: string,
    start: string,
    end: string,
    count?: number
  ): Promise<Record<string, Record<string, unknown>>>
  xrevrange(
    key: string,
    end: string,
    start: string,
    count?: number
  ): Promise<Record<string, Record<string, unknown>>>
  subscribe(channels: string | string[]): SubscriberAdapter
  publish(channel: string, message: unknown): Promise<number>
  pipeline(): PipelineAdapter
  expire(key: string, seconds: number): Promise<number>
}

/**
 * Detects if the client is an Upstash Redis client
 */
function isUpstashRedis(client: AnyRedisClient): client is UpstashRedis {
  return (
    'autoPipelineQueueSize' in client ||
    'enableAutoPipelining' in client ||
    ('addCommand' in client && 'use' in client)
  )
}

/**
 * Detects if the client is an ioredis client or cluster
 */
function isIORedis(client: AnyRedisClient): client is IORedisClient | IORedisCluster {
  return (
    'status' in client ||
    'options' in client ||
    'connector' in client
  )
}

/**
 * Normalizes ioredis stream response to match Upstash format
 * ioredis returns: [[id, [field1, value1, field2, value2]], ...]
 * Upstash returns: { id: { field1: value1, field2: value2 }, ... }
 */
function normalizeIORedisStreamResponse(
  response: Array<[string, string[]]>
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {}

  for (const [id, fields] of response) {
    const obj: Record<string, unknown> = {}
    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i]
      const rawValue = fields[i + 1]

      if (key !== undefined && rawValue !== undefined) {
        let value: unknown;

        // Try to parse JSON values, keep as string if parsing fails
        try {
          value = JSON.parse(rawValue)
        } catch {
          // Not JSON, use raw string value
          value = rawValue
        }

        obj[key] = value
      }
    }
    result[id] = obj
  }

  return result
}

/**
 * Builds ioredis-compatible xadd command arguments
 */
function buildIORedisXaddArgs(
  key: string,
  id: string,
  data: Record<string, unknown>,
  options?: { trim?: TrimConfig }
): string[] {
  const args: string[] = [key, id]

  // Convert data object to flat array
  for (const [field, value] of Object.entries(data)) {
    args.push(field)
    args.push(typeof value === "string" ? value : JSON.stringify(value))
  }

  // Handle trim options
  if (options?.trim) {
    const { type, threshold, comparison } = options.trim
    if (type === "MAXLEN") {
      args.push("MAXLEN")
      if (comparison === "=" || comparison === "~") {
        args.push(comparison)
      }
      args.push(String(threshold))
    }
  }

  return args
}

/**
 * Handler types for subscriber events
 */
type SubscribeHandler = () => void
type MessageHandler = (data: { channel: string; message: unknown }) => void
type ErrorHandler = (error: Error) => void
type UnsubscribeHandler = () => void

/**
 * Creates a subscriber adapter for Upstash Redis
 */
function createUpstashSubscriberAdapter(
  subscriber: ReturnType<UpstashRedis["subscribe"]>
): SubscriberAdapter {
  const handlers: {
    subscribe: SubscribeHandler[]
    message: MessageHandler[]
    error: ErrorHandler[]
    unsubscribe: UnsubscribeHandler[]
  } = {
    subscribe: [],
    message: [],
    error: [],
    unsubscribe: [],
  }

  // Forward Upstash events to our normalized handlers
  subscriber.on("subscribe", () => {
    handlers.subscribe.forEach((h) => h())
  })

  subscriber.on("message", ({ channel, message }) => {
    handlers.message.forEach((h) => h({ channel, message }))
  })

  subscriber.on("error", (error) => {
    handlers.error.forEach((h) => h(error))
  })

  subscriber.on("unsubscribe", () => {
    handlers.unsubscribe.forEach((h) => h())
  })

  return {
    on(
      event: "subscribe" | "message" | "error" | "unsubscribe",
      handler: SubscribeHandler | MessageHandler | ErrorHandler | UnsubscribeHandler
    ) {
      if (event === "subscribe") {
        handlers.subscribe.push(handler as SubscribeHandler)
      } else if (event === "message") {
        handlers.message.push(handler as MessageHandler)
      } else if (event === "error") {
        handlers.error.push(handler as ErrorHandler)
      } else if (event === "unsubscribe") {
        handlers.unsubscribe.push(handler as UnsubscribeHandler)
      }
    },
    off(
      event: "subscribe" | "message" | "error" | "unsubscribe",
      handler: (...args: any[]) => void
    ) {
      if (event === "subscribe") {
        const index = handlers.subscribe.indexOf(handler as SubscribeHandler)
        if (index > -1) handlers.subscribe.splice(index, 1)
      } else if (event === "message") {
        const index = handlers.message.indexOf(handler as MessageHandler)
        if (index > -1) handlers.message.splice(index, 1)
      } else if (event === "error") {
        const index = handlers.error.indexOf(handler as ErrorHandler)
        if (index > -1) handlers.error.splice(index, 1)
      } else if (event === "unsubscribe") {
        const index = handlers.unsubscribe.indexOf(handler as UnsubscribeHandler)
        if (index > -1) handlers.unsubscribe.splice(index, 1)
      }
    },
    async unsubscribe() {
      await subscriber.unsubscribe()
      // Clear all handlers to prevent memory leaks
      handlers.subscribe = []
      handlers.message = []
      handlers.error = []
      handlers.unsubscribe = []
    },
  }
}

/**
 * Creates a subscriber adapter for ioredis
 */
function createIORedisSubscriberAdapter(
  client: IORedisClient | IORedisCluster,
  channels: string[]
): SubscriberAdapter {
  // Duplicate the client for pub/sub to avoid blocking commands on subscriber connection
  // ioredis requires separate connections for pub/sub vs command operations
  const subscriberClient = (client as any).duplicate?.() || client
  
  const handlers: {
    subscribe: SubscribeHandler[]
    message: MessageHandler[]
    error: ErrorHandler[]
    unsubscribe: UnsubscribeHandler[]
  } = {
    subscribe: [],
    message: [],
    error: [],
    unsubscribe: [],
  }

  // Subscribe to channels with proper callback handling
  const subscribeCallback = (err?: Error) => {
    if (err) {
      handlers.error.forEach((h) => h(err))
    } else {
      handlers.subscribe.forEach((h) => h())
    }
  }

  subscriberClient.subscribe(...channels, subscribeCallback)

  // Handle messages
  subscriberClient.on("message", (channel: string, message: string) => {
    let parsedMessage: unknown = message
    try {
      parsedMessage = JSON.parse(message)
    } catch {
      // Not JSON, keep as string value
      parsedMessage = message
    }
    handlers.message.forEach((h) => h({ channel, message: parsedMessage }))
  })

  // Handle errors
  subscriberClient.on("error", (error: Error) => {
    handlers.error.forEach((h) => h(error))
  })

  return {
    on(
      event: "subscribe" | "message" | "error" | "unsubscribe",
      handler: SubscribeHandler | MessageHandler | ErrorHandler | UnsubscribeHandler
    ) {
      if (event === "subscribe") {
        handlers.subscribe.push(handler as SubscribeHandler)
      } else if (event === "message") {
        handlers.message.push(handler as MessageHandler)
      } else if (event === "error") {
        handlers.error.push(handler as ErrorHandler)
      } else if (event === "unsubscribe") {
        handlers.unsubscribe.push(handler as UnsubscribeHandler)
      }
    },
    off(
      event: "subscribe" | "message" | "error" | "unsubscribe",
      handler: (...args: any[]) => void
    ) {
      if (event === "subscribe") {
        const index = handlers.subscribe.indexOf(handler as SubscribeHandler)
        if (index > -1) handlers.subscribe.splice(index, 1)
      } else if (event === "message") {
        const index = handlers.message.indexOf(handler as MessageHandler)
        if (index > -1) handlers.message.splice(index, 1)
      } else if (event === "error") {
        const index = handlers.error.indexOf(handler as ErrorHandler)
        if (index > -1) handlers.error.splice(index, 1)
      } else if (event === "unsubscribe") {
        const index = handlers.unsubscribe.indexOf(handler as UnsubscribeHandler)
        if (index > -1) handlers.unsubscribe.splice(index, 1)
      }
    },
    async unsubscribe() {
      await subscriberClient.unsubscribe(...channels)
      handlers.unsubscribe.forEach((h) => h())
      // Clear all handlers to prevent memory leaks
      handlers.subscribe = []
      handlers.message = []
      handlers.error = []
      handlers.unsubscribe = []
      // Close the duplicated connection if different from main client
      if (subscriberClient !== client && typeof subscriberClient.quit === 'function') {
        await subscriberClient.quit().catch(() => {
          // Ignore errors during cleanup
        })
      }
    },
  }
}

/**
 * Creates a pipeline adapter for Upstash Redis
 */
function createUpstashPipelineAdapter(
  pipeline: ReturnType<UpstashRedis["pipeline"]>
): PipelineAdapter {
  return {
    xadd(key, id, data, options) {
      pipeline.xadd(key, id, data, options)
      return this
    },
    expire(key, seconds) {
      pipeline.expire(key, seconds)
      return this
    },
    publish(channel, message) {
      pipeline.publish(channel, message)
      return this
    },
    async exec() {
      return await pipeline.exec()
    },
  }
}

/**
 * Creates a pipeline adapter for ioredis
 */
function createIORedisPipelineAdapter(
  pipeline: ReturnType<IORedisClient["pipeline"]>
): PipelineAdapter {
  return {
    xadd(key, id, data, options) {
      const args = buildIORedisXaddArgs(key, id, data, options)
      type XaddFunction = (...args: string[]) => void
      ;(pipeline.xadd as XaddFunction)(...args)
      return this
    },
    expire(key, seconds) {
      pipeline.expire(key, seconds)
      return this
    },
    publish(channel, message) {
      const messageStr = typeof message === "string" ? message : JSON.stringify(message)
      pipeline.publish(channel, messageStr)
      return this
    },
    async exec() {
      const results = await pipeline.exec()
      if (!results) return []

      // ioredis returns [[error, result], ...]
      // Collect all errors with their indices for better debugging
      const errors: Array<{ index: number; error: Error }> = []
      const processedResults = results.map(([err, result], index) => {
        if (err) {
          errors.push({ index, error: err as Error })
          return null
        }
        return result
      })

      if (errors.length > 0) {
        const errorMessage = `Pipeline execution failed: ${errors.length} command(s) failed at indices: ${errors.map((e) => e.index).join(", ")}`
        const error = new Error(errorMessage) as Error & { pipelineErrors?: Array<{ index: number; error: Error }> }
        error.pipelineErrors = errors
        throw error
      }

      return processedResults
    },
  }
}

/**
 * Creates a unified Redis adapter for the given client
 */
export function createRedisAdapter(client: AnyRedisClient): RedisAdapter {
  if (!client) {
    throw new Error(
      "Redis client is required. Please provide an initialized @upstash/redis or ioredis client instance."
    )
  }

  if (isUpstashRedis(client)) {
    return createUpstashAdapter(client)
  } else if (isIORedis(client)) {
    const ioClient = client as IORedisClient | IORedisCluster
    // Check connection status if available
    if ('status' in ioClient && ioClient.status === 'end') {
      throw new Error(
        "ioredis client connection is closed. Please ensure the client is connected before creating the adapter."
      )
    }
    return createIORedisAdapter(ioClient)
  } else {
    throw new Error(
      "Unsupported Redis client type. Supported clients are:\n" +
      "  - @upstash/redis (v1.35.4 or higher)\n" +
      "  - ioredis (v5.0.0 or higher)\n" +
      "Please install and properly instantiate one of these clients."
    )
  }
}

/**
 * Creates an adapter for Upstash Redis client
 */
function createUpstashAdapter(client: UpstashRedis): RedisAdapter {
  return {
    async xadd(key, id, data, options) {
      return await client.xadd(key, id, data, options)
    },
    async xrange(key, start, end, count) {
      return await client.xrange(key, start, end, count)
    },
    async xrevrange(key, end, start, count) {
      return await client.xrevrange(key, end, start, count)
    },
    subscribe(channels) {
      const channelArray = Array.isArray(channels) ? channels : [channels]
      type SubscribeFunction = (
        ...channels: string[]
      ) => ReturnType<UpstashRedis["subscribe"]>
      const subscriber = (client.subscribe as SubscribeFunction)(...channelArray)
      return createUpstashSubscriberAdapter(subscriber)
    },
    async publish(channel, message) {
      return await client.publish(channel, message)
    },
    pipeline() {
      const pipeline = client.pipeline()
      return createUpstashPipelineAdapter(pipeline)
    },
    async expire(key, seconds) {
      return await client.expire(key, seconds)
    },
  }
}

/**
 * Creates an adapter for ioredis client
 */
function createIORedisAdapter(client: IORedisClient | IORedisCluster): RedisAdapter {
  return {
    async xadd(key, id, data, options) {
      const args = buildIORedisXaddArgs(key, id, data, options)
      type XaddFunction = (...args: string[]) => Promise<string>
      return await (client.xadd as XaddFunction)(...args)
    },
    async xrange(key, start, end, count) {
      type XrangeFunction = {
        (key: string, start: string, end: string): Promise<Array<[string, string[]]>>
        (
          key: string,
          start: string,
          end: string,
          countKey: "COUNT",
          count: number
        ): Promise<Array<[string, string[]]>>
      }
      let response: Array<[string, string[]]>
      if (count !== undefined) {
        response = await (client.xrange as XrangeFunction)(key, start, end, "COUNT", count)
      } else {
        response = await (client.xrange as XrangeFunction)(key, start, end)
      }
      return normalizeIORedisStreamResponse(response)
    },
    async xrevrange(key, end, start, count) {
      type XrevrangeFunction = {
        (key: string, end: string, start: string): Promise<Array<[string, string[]]>>
        (
          key: string,
          end: string,
          start: string,
          countKey: "COUNT",
          count: number
        ): Promise<Array<[string, string[]]>>
      }
      let response: Array<[string, string[]]>
      if (count !== undefined) {
        response = await (client.xrevrange as XrevrangeFunction)(key, end, start, "COUNT", count)
      } else {
        response = await (client.xrevrange as XrevrangeFunction)(key, end, start)
      }
      return normalizeIORedisStreamResponse(response)
    },
    subscribe(channels) {
      const channelArray = Array.isArray(channels) ? channels : [channels]
      return createIORedisSubscriberAdapter(client, channelArray)
    },
    async publish(channel, message) {
      const messageStr = typeof message === "string" ? message : JSON.stringify(message)
      return (await client.publish(channel, messageStr)) as number
    },
    pipeline() {
      const pipeline = client.pipeline()
      return createIORedisPipelineAdapter(pipeline)
    },
    async expire(key, seconds) {
      return (await client.expire(key, seconds)) as number
    },
  }
}


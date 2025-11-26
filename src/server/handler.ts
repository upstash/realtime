import type { Opts, Realtime } from "./realtime.js"
import {
  userEvent,
  systemEvent,
  type SystemEvent,
  type UserEvent,
} from "../shared/types.js"
import { compareStreamIds } from "./utils.js"

export function handle<T extends Opts>(config: {
  realtime: Realtime<T>
  middleware?: ({
    request,
    channels,
  }: {
    request: Request
    channels: string[]
  }) => Response | void | Promise<Response | void>
}): (request: Request) => Promise<Response | void> {
  return async (request: Request) => {
    const requestStartTime = Date.now()
    const { searchParams } = new URL(request.url)
    const rawChannels =
      searchParams.getAll("channel").length > 0
        ? searchParams.getAll("channel")
        : ["default"]
    const channels = [...new Set(rawChannels)]

    const redis = config.realtime._redis
    const logger = config.realtime._logger

    if (config.middleware) {
      const result = await config.middleware({ request, channels })
      if (result) return result
    }

    if (!redis) {
      logger.error("No Redis instance provided to Realtime")
      return new Response(JSON.stringify({ error: "Redis not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    }

    let cleanup: (() => Promise<void>) | undefined
    let subscriber: ReturnType<typeof redis.subscribe>
    let subCount: number = 0
    let reconnectTimeout: NodeJS.Timeout | undefined
    let keepaliveInterval: NodeJS.Timeout | undefined
    let isClosed = false
    let handleAbort: (() => Promise<void>) | undefined
    let onSubscribe: (() => Promise<void>) | undefined
    let onError: ((err: Error) => void) | undefined
    let onUnsubscribe: (() => void) | undefined
    let onMessage:
      | (({ message, channel }: { message: unknown; channel: string }) => Promise<void>)
      | undefined

    const stream = new ReadableStream({
      async start(controller) {
        if (request.signal.aborted) {
          controller.close()
          return
        }

        cleanup = async () => {
          if (isClosed) return
          isClosed = true

          clearTimeout(reconnectTimeout)
          clearInterval(keepaliveInterval)

          if (handleAbort) {
            request.signal.removeEventListener("abort", handleAbort)
          }

          await subscriber?.unsubscribe().catch((err) => {
            logger.error("⚠️ Error closing connection:", err)
          })

          try {
            if (!request.signal.aborted) controller.close()
            logger.log("✅ Connection closed successfully.")
          } catch (err) {
            logger.error("⚠️ Error closing controller:", err)
          }
        }

        handleAbort = async () => {
          await cleanup?.()
        }

        request.signal.addEventListener("abort", handleAbort)

        subscriber = redis.subscribe(channels)

        const safeEnqueue = (data: Uint8Array) => {
          if (isClosed) return

          try {
            controller.enqueue(data)
          } catch (err) {
            logger.error("⚠️ Error closing controller:", err)
          }
        }

        const elapsedMs = Date.now() - requestStartTime
        const remainingMs = config.realtime._maxDurationSecs * 1000 - elapsedMs
        const streamDurationMs = Math.max(remainingMs - 2000, 1000)

        reconnectTimeout = setTimeout(async () => {
          const reconnectEvent: SystemEvent = {
            type: "reconnect",
            timestamp: Date.now(),
          }

          safeEnqueue(json(reconnectEvent))

          await cleanup?.()
        }, streamDurationMs)

        let buffer: UserEvent[] = []
        let isHistoryReplayed = false
        const lastHistoryIds = new Map<string, string>()

        onSubscribe = async () => {
          await Promise.all(
            channels.map(async (channel) => {
              const connectedEvent: SystemEvent = {
                type: "connected",
                channel,
              }

              safeEnqueue(json(connectedEvent))

              const lastAck =
                searchParams.get(`last_ack_${channel}`) ?? String(Date.now())

              const missingMessages = await redis.xrange(channel, `(${lastAck}`, "+")

              const entries = Object.entries(missingMessages)
              if (entries.length > 0) {
                entries.forEach(([id, value]) => {
                  const eventWithId = { ...value, id }
                  const event = userEvent.safeParse(eventWithId)
                  if (event.success) safeEnqueue(json(event.data))
                })
                lastHistoryIds.set(channel, entries[entries.length - 1]?.[0] ?? "")
              }
            })
          )

          for (const msg of buffer) {
            const channelLastId = lastHistoryIds.get(msg.channel)
            if (channelLastId && compareStreamIds(msg.id, channelLastId) <= 0) continue
            safeEnqueue(json(msg))
          }

          buffer = []
          isHistoryReplayed = true

          logger.log("✅ Subscription established:", { channels })
        }

        onError = (err) => {
          logger.error("⚠️ Redis subscriber error:", err)

          const errorEvent: SystemEvent = {
            type: "error",
            error: err.message,
          }

          safeEnqueue(json(errorEvent))
        }

        onUnsubscribe = async () => {
          logger.log("⬅️ Client unsubscribed from channels:", channels)

          await cleanup?.()
        }

        onMessage = async ({ message }) => {
          let payload: Record<string, unknown>

          if (typeof message === "string") {
            try {
              payload = JSON.parse(message)
            } catch {
              payload = { data: message }
            }
          } else if (typeof message === "object" && message !== null) {
            payload = message as Record<string, unknown>
          } else {
            payload = { data: message }
          }

          const systemResult = systemEvent.safeParse(payload)

          if (systemResult.success) {
            safeEnqueue(json(systemResult.data))
            return
          }

          logger.log("⬇️  Received event:", payload)

          const result = userEvent.safeParse(payload)

          if (result.success) {
            if (!isHistoryReplayed) {
              buffer.push(result.data)
            } else {
              safeEnqueue(json(result.data))
            }
          }
        }

        subscriber.on("subscribe", () => {
          subCount = subCount + 1
          if (subCount === channels.length) onSubscribe?.()
        })
        subscriber.on("error", onError)
        subscriber.on("unsubscribe", onUnsubscribe)
        subscriber.on("message", onMessage)

        keepaliveInterval = setInterval(async () => {
          const channel = channels[0]
          if (channel) {
            await redis.publish(channel, {
              type: "ping",
              timestamp: Date.now(),
            })
          }
        }, 60_000)
      },

      async cancel() {
        if (isClosed) return
        await cleanup?.()
      },
    })

    return new StreamingResponse(stream)
  }
}

export function json(data: SystemEvent | UserEvent) {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
}

export class StreamingResponse extends Response {
  constructor(res: ReadableStream<any>, init?: ResponseInit) {
    super(res as any, {
      ...init,
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Cache-Control",
        ...init?.headers,
      },
    })
  }
}



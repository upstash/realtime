import type { Opts, Realtime } from "./realtime.js"
import type { SystemEvent, UserEvent } from "../types.js"

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
    const channels =
      searchParams.getAll("channels").length > 0
        ? searchParams.getAll("channels")
        : ["default"]
    const reconnect = searchParams.get("reconnect")
    const history_all = searchParams.get("history_all")
    const history_length = searchParams.get("history_length")
    const history_since = searchParams.get("history_since")
    const connection_start = searchParams.get("connection_start")

    const lastAckMap = new Map<string, string>()
    channels.forEach((channel) => {
      const lastAck = searchParams.get(`last_ack_${channel}`)
      if (lastAck) {
        lastAckMap.set(channel, lastAck)
      }
    })

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
            logger.error("⚠️ Error during unsubscribe:", err)
          })

          controller.close()
        }

        handleAbort = async () => {
          await cleanup?.()
        }

        request.signal.addEventListener("abort", handleAbort)

        subscriber = redis.subscribe(channels.map((ch) => `channel:${ch}`))

        const safeEnqueue = (data: Uint8Array) => {
          if (!isClosed) controller.enqueue(data)
        }

        const elapsedMs = Date.now() - requestStartTime
        const remainingMs = config.realtime._maxDurationSecs * 1000 - elapsedMs
        const streamDurationMs = Math.max(remainingMs - 2000, 1000)

        reconnectTimeout = setTimeout(async () => {
          safeEnqueue(json({ type: "reconnect" }))
          await cleanup?.()
        }, streamDurationMs)

        onSubscribe = async () => {
          logger.log(`✅ Subscription established:`, { channels })
          try {
            for (const channel of channels) {
              const last_ack = lastAckMap.get(channel)

              if (reconnect === "true" && last_ack) {
                const startId = `(${last_ack}`
                const missingMessages = await redis.xrange(
                  `channel:${channel}`,
                  startId,
                  "+"
                )

                const connectedEvent: SystemEvent = {
                  type: "connected",
                  channel,
                }

                safeEnqueue(json(connectedEvent))

                if (Array.from(Object.keys(missingMessages)).length > 0) {
                  Object.entries(missingMessages).forEach(([__stream_id, value]) => {
                    if (typeof value === "object" && value !== null) {
                      const { __event_path, data } = value as Record<string, unknown>
                      const userEvent: UserEvent = {
                        data,
                        __event_path: __event_path as string[],
                        __stream_id,
                        __channel: channel,
                      }
                      safeEnqueue(json(userEvent))
                    }
                  })
                }
              } else {
                const connectionStart = connection_start ?? String(Date.now())

                if (history_all || history_length || history_since) {
                  let start = history_since ? history_since : "-"
                  let count = history_length ? parseInt(history_length, 10) : undefined

                  if (
                    history_since &&
                    parseInt(history_since, 10) > parseInt(connectionStart, 10)
                  ) {
                    start = connectionStart
                  }

                  const history = await redis.xrevrange(
                    `channel:${channel}`,
                    "+",
                    start,
                    count
                  )

                  const messages = Object.entries(history)
                  const currentCursorId = messages[0]?.[0] ?? "0-0"
                  const oldestToNewestMessages = reverse(messages)

                  const connectedEvent: SystemEvent = {
                    type: "connected",
                    channel,
                    cursor: currentCursorId,
                  }

                  safeEnqueue(json(connectedEvent))

                  oldestToNewestMessages.forEach(([__stream_id, value]) => {
                    if (typeof value === "object" && value !== null) {
                      const { __event_path, data } = value as Record<string, unknown>
                      const userEvent: UserEvent = {
                        data,
                        __event_path: __event_path as string[],
                        __stream_id,
                        __channel: channel,
                      }
                      safeEnqueue(json(userEvent))
                    }
                  })
                } else {
                  const history = await redis.xrevrange(
                    `channel:${channel}`,
                    "+",
                    connectionStart
                  )

                  const messages = Object.entries(history)
                  const currentCursorId = messages[0]?.[0] ?? "0-0"
                  const oldestToNewestMessages = reverse(messages)

                  const connectedEvent: SystemEvent = {
                    type: "connected",
                    channel,
                    cursor: currentCursorId,
                  }

                  safeEnqueue(json(connectedEvent))

                  oldestToNewestMessages.forEach(([__stream_id, value]) => {
                    if (typeof value === "object" && value !== null) {
                      const { __event_path, data } = value as Record<string, unknown>
                      const userEvent: UserEvent = {
                        data,
                        __event_path: __event_path as string[],
                        __stream_id,
                        __channel: channel,
                      }
                      safeEnqueue(json(userEvent))
                    }
                  })
                }
              }
            }
          } catch (err) {
            logger.error("Error in subscribe handler:", err)
            safeEnqueue(
              json({
                type: "error",
                error: err instanceof Error ? err.message : "Unknown error",
              })
            )
          }
        }

        onError = (err: Error) => {
          logger.error("⚠️ Redis subscriber error:", err)

          const errorEvent: SystemEvent = {
            type: "error",
            error: err.message,
          }

          safeEnqueue(json(errorEvent))
        }

        onUnsubscribe = async () => {
          logger.log("⬅️ Client unsubscribed from channels:", channels)

          channels.forEach((channel) => {
            const unsubscribedEvent: SystemEvent = {
              type: "disconnected",
              channel,
            }

            safeEnqueue(json(unsubscribedEvent))
          })

          await cleanup?.()
        }

        onMessage = async ({
          message,
          channel: redisChannel,
        }: {
          message: unknown
          channel: string
        }) => {
          const channel = redisChannel.replace(/^channel:/, "")

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

          if (payload.type === "ping") {
            const pingEvent: SystemEvent = {
              type: "ping",
              timestamp: payload.timestamp as number,
            }
            safeEnqueue(json(pingEvent))
            return
          }

          const { __stream_id, __event_path, data } = payload

          logger.log("⬇️  Received event:", { channel, __event_path, data })

          const userEvent: UserEvent = {
            data,
            __event_path: __event_path as string[],
            __stream_id: __stream_id as string,
            __channel: channel,
          }

          safeEnqueue(json(userEvent))
        }

        subscriber.on("subscribe", onSubscribe)
        subscriber.on("error", onError)
        subscriber.on("unsubscribe", onUnsubscribe)
        subscriber.on("message", onMessage)

        keepaliveInterval = setInterval(async () => {
          for (const channel of channels) {
            await redis.publish(`channel:${channel}`, {
              type: "ping",
              timestamp: Date.now(),
            })
          }
        }, 10_000)
      },

      async cancel() {
        if (isClosed) return
        await cleanup?.()
      },
    })

    return new StreamingResponse(stream)
  }
}

export function json<T>(data: SystemEvent | UserEvent<T>) {
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

function reverse(array: Array<any>) {
  const length = array.length

  let left = null
  let right = null

  for (left = 0, right = length - 1; left < right; left += 1, right -= 1) {
    const temporary = array[left]
    array[left] = array[right]
    array[right] = temporary
  }

  return array
}

import type { Opts, Realtime } from "./realtime.js"
import type { SystemEvent, UserEvent } from "../types.js"

export function handle<T extends Opts>(config: {
  realtime: Realtime<T>
  middleware?: ({
    request,
    channel,
  }: {
    request: Request
    channel: string
  }) => Response | void | Promise<Response | void>
}): (request: Request) => Promise<Response | void> {
  return async (request: Request) => {
    const requestStartTime = Date.now()
    const { searchParams } = new URL(request.url)
    const channel = searchParams.get("channel") || "default"
    const reconnect = searchParams.get("reconnect")
    const last_ack = searchParams.get("last_ack")

    const redis = config.realtime._redis
    const logger = config.realtime._logger

    if (config.middleware) {
      const result = await config.middleware({ request, channel })
      if (result) return result
    }

    if (!redis) {
      logger.error("No Redis instance provided to Realtime")
      return new Response(JSON.stringify({ error: "Redis not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    }

    let subscriber: ReturnType<typeof redis.subscribe>
    let reconnectTimeout: NodeJS.Timeout | undefined
    let pingInterval: NodeJS.Timeout
    let isClosed = false

    const stream = new ReadableStream({
      async start(controller) {
        if (request.signal.aborted) {
          controller.close()
          return
        }

        subscriber = redis.subscribe(`channel:${channel}:event`)

        const safeEnqueue = (data: Uint8Array) => {
          if (!isClosed) controller.enqueue(data)
        }

        const elapsedMs = Date.now() - requestStartTime
        const remainingMs = config.realtime._maxDurationSecs * 1000 - elapsedMs
        const streamDurationMs = Math.max(remainingMs - 2000, 1000)

        pingInterval = setInterval(() => {
          safeEnqueue(json({ type: "ping" }))
        }, 10_000)

        reconnectTimeout = setTimeout(() => {
          safeEnqueue(json({ type: "reconnect" }))
          isClosed = true
          controller.close()
          this.cancel?.()
        }, streamDurationMs)

        const setupSubscription = async () => {
          subscriber.on("subscribe", async () => {
            logger.log("Regular subscription established!")
            try {
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
                      }
                      safeEnqueue(json(userEvent))
                    }
                  })
                }
              } else {
                const lastMessage = await redis.xrevrange(
                  `channel:${channel}`,
                  "+",
                  "-",
                  1
                )

                const messageEntries = Object.entries(lastMessage)
                const currentCursor = messageEntries[0]?.[0] ?? "0-0"

                const connectedEvent: SystemEvent = {
                  type: "connected",
                  channel,
                  cursor: currentCursor,
                }

                safeEnqueue(json(connectedEvent))
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
          })

          subscriber.on("error", (err) => {
            logger.error("Redis subscriber error:", err)

            const errorEvent: SystemEvent = {
              type: "error",
              error: err.message,
            }

            safeEnqueue(json(errorEvent))
          })

          subscriber.on("unsubscribe", () => {
            logger.log("Client unsubscribed from channel:", channel)

            const unsubscribedEvent: SystemEvent = {
              type: "disconnected",
              channel,
            }

            safeEnqueue(json(unsubscribedEvent))
          })

          subscriber.on("message", async ({ message }) => {
            logger.log("message", { message })

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

            const { __stream_id, __event_path, data } = payload

            const userEvent: UserEvent = {
              data,
              __event_path: __event_path as string[],
              __stream_id: __stream_id as string,
            }

            safeEnqueue(json(userEvent))
          })
        }

        await setupSubscription()
      },

      cancel() {
        isClosed = true
        clearInterval(pingInterval)
        clearTimeout(reconnectTimeout)

        if (subscriber) {
          subscriber.unsubscribe().catch((err) => {
            logger.error("Error during unsubscribe:", err)
          })
        }
      },
    })

    return new StreamingResponse(stream)
  }
}

function json<T>(data: SystemEvent | UserEvent<T>) {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
}

class StreamingResponse extends Response {
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

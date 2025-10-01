import type { Opts, Realtime } from "./realtime.js"

export function handle<T extends Opts>(config: {
  realtime: Realtime<T>
  middleware?: ({ request, channel }: { request: Request; channel: string }) => unknown
}) {
  return async (request: Request) => {
    const { searchParams } = new URL(request.url)
    const channel = searchParams.get("channel") || "default"
    const reconnect = searchParams.get("reconnect")
    const last_ack = searchParams.get("last_ack")

    const redis = config.realtime._redis
    const logger = config.realtime._logger

    if (config.middleware) {
      try {
        const result = await config.middleware({ request, channel })
        if (result) return result
      } catch (err) {
        logger.error("Middleware error:", err)
      }
    }

    if (!redis) {
      logger.error("No Redis instance provided to Realtime")
      return new Response(JSON.stringify({ error: "Redis not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    }

    let subscriber: ReturnType<typeof redis.psubscribe>
    let reconnectTimeout: NodeJS.Timeout
    let isClosed = false

    try {
      subscriber = redis.psubscribe(`channel:${channel}:event:*`)
    } catch (error) {
      logger.error("Failed to create Redis subscriber:", error)
      return new Response(JSON.stringify({ error: "Failed to subscribe to Redis" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    }

    const stream = new ReadableStream({
      async start(controller) {
        const safeEnqueue = (data: Uint8Array) => {
          if (!isClosed) controller.enqueue(data)
        }

        reconnectTimeout = setTimeout(() => {
          isClosed = true
          safeEnqueue(json({ type: "reconnect" }))
          controller.close()
        }, (config.realtime._maxDurationSecs - 2) * 1000)

        const setupSubscription = async () => {
          subscriber.on("psubscribe", async () => {
            try {
              if (reconnect === "true" && last_ack) {
                const startId = `(${last_ack}`
                const messages = await redis.xrange(
                  `channel:${channel}`,
                  startId,
                  "+"
                )
                Object.entries(messages).forEach(([id, value]) => {
                  if (typeof value === "object" && value !== null && "event" in value) {
                    const { __event_path, __stream_id, data } = value as Record<
                      string,
                      unknown
                    >
                    safeEnqueue(json({ data, __event_path, __stream_id }))
                  }
                })

                safeEnqueue(json({ type: "connected", channel }))
              } else {
                const lastMessage = await redis.xrevrange(
                  `channel:${channel}`,
                  "+",
                  "-",
                  1
                )
                const messageEntries = Object.entries(lastMessage)
                const currentCursor =
                  messageEntries.length > 0 ? messageEntries[0]?.[0] : "0-0"
                safeEnqueue(json({ type: "connected", channel, cursor: currentCursor }))
              }
            } catch (err) {
              logger.error("Error in psubscribe handler:", err)
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
            safeEnqueue(
              json({ type: "error", error: err?.message || "Subscriber error" })
            )
          })

          subscriber.on("punsubscribe", () => {
            logger.log("Client unsubscribed from channel:", channel)
            safeEnqueue(json({ type: "disconnected", channel }))
          })

          subscriber.on("pmessage", async ({ channel, message }) => {
            logger.log("pmessage", { channel, message })

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

            safeEnqueue(json({ data, __event_path, __stream_id }))
          })
        }

        await setupSubscription()
      },

      cancel() {
        isClosed = true
        clearTimeout(reconnectTimeout)
        subscriber?.unsubscribe([`channel:${channel}:*`])
      },
    })

    return new StreamingResponse(stream)
  }
}

function json(data: Record<string, unknown>) {
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

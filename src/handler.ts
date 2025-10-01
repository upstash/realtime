import type { Opts, Realtime } from "./realtime.js"

export function handle<T extends Opts>(config: { realtime: Realtime<T> }) {
  return async (request: Request) => {
    const { searchParams } = new URL(request.url)
    const namespace = searchParams.get("namespace") || "default"
    const reconnect = searchParams.get("reconnect")
    const last_ack = searchParams.get("last_ack")

    const redis = config.realtime._redis

    if (!redis) {
      throw new Error("No Redis instance provided to Realtime.")
    }

    const subscriber = redis.psubscribe(`namespace:${namespace}:*`)
    let reconnectTimeout: NodeJS.Timeout
    let isClosed = false

    const stream = new ReadableStream({
      async start(controller) {
        const safeEnqueue = (data: Uint8Array) => {
          if (!isClosed) {
            controller.enqueue(data)
          }
        }

        reconnectTimeout = setTimeout(() => {
          isClosed = true
          safeEnqueue(json({ type: "reconnect" }))
          controller.close()
        }, (config.realtime._maxDurationSecs - 2) * 1000)

        const setupSubscription = async () => {
          subscriber.on("psubscribe", async () => {
            if (reconnect === "true" && last_ack) {
              const startId = `(${last_ack}`
              const messages = await redis.xrange(`namespace:${namespace}`, startId, "+")
              Object.entries(messages).forEach(([id, value]) => {
                if (typeof value === "object" && value !== null && "event" in value) {
                  const { event, ...rest } = value as Record<string, unknown>
                  safeEnqueue(json({ ...rest, event, id }))
                }
              })
              safeEnqueue(json({ type: "connected", namespace }))
            } else {
              const lastMessage = await redis.xrevrange(
                `namespace:${namespace}`,
                "+",
                "-",
                1
              )
              const messageEntries = Object.entries(lastMessage)
              const currentCursor =
                messageEntries.length > 0 ? messageEntries[0]?.[0] : "0-0"
              safeEnqueue(
                json({ type: "connected", namespace, cursor: currentCursor })
              )
            }
          })

          subscriber.on("error", (err) => {
            safeEnqueue(json({ type: "error", error: err?.message }))
          })

          subscriber.on("punsubscribe", () => {
            safeEnqueue(json({ type: "disconnected", namespace }))
          })

          subscriber.on("pmessage", async ({ channel, message }) => {
            let payload: Record<string, unknown>
            if (typeof message === "string") {
              try {
                payload = JSON.parse(message)
              } catch {
                payload = { message }
              }
            } else if (typeof message === "object" && message !== null) {
              payload = message as Record<string, unknown>
            } else {
              payload = { message }
            }
            const { __stream_id, __event_id, ...rest } = payload
            safeEnqueue(json({ ...rest, event: __event_id, id: __stream_id }))
          })
        }

        await setupSubscription()
      },

      cancel() {
        isClosed = true
        clearTimeout(reconnectTimeout)
        subscriber?.unsubscribe([`namespace:${namespace}:*`])
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

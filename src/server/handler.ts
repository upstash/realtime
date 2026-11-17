import type { Opts, Realtime } from "./realtime.js"
import {
  STREAM_ID_PATTERN,
  userEvent,
  type SystemEvent,
  type UserEvent,
} from "../shared/types.js"
import {
  encodeFrame,
  getChannelHub,
  type ChannelMembership,
  type ChannelMessage,
} from "./hub.js"
import { canDeliverLive, streamOrder } from "./utils.js"

/**
 * @see node_modules/@upstash/realtime/docs/sdk/features/middleware.mdx
 */
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

    // Channels the SDK cannot subscribe to are served from history only:
    // missed events are replayed on every connection, but nothing arrives
    // live.
    const liveChannels = channels.filter(canDeliverLive)

    if (liveChannels.length < channels.length) {
      logger.warn(
        "⚠️ Channels that cannot be subscribed to are replay-only:",
        channels.filter((channel) => !liveChannels.includes(channel))
      )
    }

    const hub = getChannelHub(redis, logger)
    let cleanup: (() => void) | undefined

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (request.signal.aborted) {
          controller.close()
          return
        }

        let isClosed = false
        let isHistoryReplayed = false
        let reconnectTimeout: ReturnType<typeof setTimeout> | undefined
        let buffer: Extract<ChannelMessage, { type: "user" }>[] = []
        let memberships: ChannelMembership[] = []
        // Per channel, the position up to which this client already has
        // everything: what it acknowledged, then what was replayed to it. A
        // live copy of such an event can still arrive later, from a shared
        // subscription that is behind or from an emitter that published out
        // of order, and must not be delivered again.
        const deliveredUpTo = new Map<string, string>()

        for (const channel of channels) {
          const lastAck = searchParams.get(`last_ack_${channel}`)
          // Only ids Redis assigned. A timestamp comes from the client's
          // clock and says nothing reliable about stream positions.
          if (lastAck && STREAM_ID_PATTERN.test(lastAck)) {
            deliveredUpTo.set(channel, streamOrder(lastAck))
          }
        }

        const safeEnqueue = (frame: Uint8Array) => {
          if (isClosed) return

          try {
            controller.enqueue(frame)
          } catch (err) {
            logger.error("⚠️ Error closing controller:", err)
          }
        }

        // A chunk belongs to whoever reads it, so a frame shared between
        // connections is copied rather than handed out directly.
        const enqueueShared = (frame: Uint8Array) => safeEnqueue(frame.slice())

        const leaveChannels = () => {
          for (const membership of memberships) membership.leave()
          memberships = []
        }

        cleanup = () => {
          if (isClosed) return
          isClosed = true

          clearTimeout(reconnectTimeout)
          request.signal.removeEventListener("abort", handleAbort)
          leaveChannels()

          try {
            if (!request.signal.aborted) controller.close()
            logger.log("✅ Connection closed successfully.")
          } catch (err) {
            logger.error("⚠️ Error closing controller:", err)
          }
        }

        const handleAbort = () => cleanup?.()

        request.signal.addEventListener("abort", handleAbort)

        const requestReconnect = (timestamp: number) => {
          const reconnectEvent: SystemEvent = { type: "reconnect", timestamp }
          safeEnqueue(encodeFrame(reconnectEvent))
          cleanup?.()
        }

        const elapsedMs = Date.now() - requestStartTime
        const remainingMs = config.realtime._maxDurationSecs * 1000 - elapsedMs
        const streamDurationMs = Math.max(remainingMs - 2000, 1000)

        reconnectTimeout = setTimeout(() => requestReconnect(Date.now()), streamDurationMs)

        const wasDelivered = ({ event, order }: Extract<ChannelMessage, { type: "user" }>) => {
          const position = deliveredUpTo.get(event.channel)
          return position !== undefined && order <= position
        }

        const replayHistory = async () => {
          if (isClosed) return

          for (const channel of channels) {
            const connectedEvent: SystemEvent = { type: "connected", channel }
            safeEnqueue(encodeFrame(connectedEvent))
          }

          const pipeline = redis.pipeline()

          for (const channel of channels) {
            const lastAck = searchParams.get(`last_ack_${channel}`) ?? String(Date.now())
            pipeline.xrange(channel, `(${lastAck}`, "+")
          }

          const histories = await pipeline.exec<Record<string, Record<string, unknown>>[]>()

          histories.forEach((missingMessages, index) => {
            const channel = channels[index]
            const entries = Object.entries(missingMessages)
            const lastEntry = entries[entries.length - 1]
            if (!channel || !lastEntry) return

            for (const [id, value] of entries) {
              const event = userEvent.safeParse({ ...value, id })
              if (event.success) safeEnqueue(encodeFrame(event.data))
            }

            deliveredUpTo.set(channel, streamOrder(lastEntry[0]))
          })

          for (const message of buffer) {
            if (!wasDelivered(message)) enqueueShared(message.frame)
          }

          buffer = []
          isHistoryReplayed = true

          logger.log("✅ Subscription established:", { channels })
        }

        // Nothing more can be delivered on this connection. It stays open and
        // silent, so the client's ping timeout makes it reconnect and retry
        // from its last acknowledged event. Closing it instead would have the
        // browser retry every few seconds for as long as the failure lasts.
        const abandon = () => {
          leaveChannels()
          buffer = []
        }

        const listener = {
          onMessage: (message: ChannelMessage) => {
            if (message.type === "user") {
              if (!isHistoryReplayed) {
                buffer.push(message)
                return
              }

              if (deliveredUpTo.size > 0 && wasDelivered(message)) return
            }

            enqueueShared(message.frame)
          },
          // The shared subscription was lost. Have the client resume from its
          // last acknowledged event on a fresh connection. For a channel it
          // has no acknowledgement for, it resumes from the given time: when
          // the subscription last worked, but not from before this connection
          // existed, since the subscription may have been lost before that.
          onClose: (aliveAt: number) => requestReconnect(Math.max(aliveAt, requestStartTime)),
        }

        try {
          for (const [index, channel] of liveChannels.entries()) {
            // The first channel is the one whose pings keep this client's
            // connection from timing out.
            memberships.push(hub.join(channel, listener, { isHeartbeat: index === 0 }))
          }
        } catch (err) {
          // Leave whatever was joined before the failure.
          cleanup()
          throw err
        }

        Promise.all(memberships.map((membership) => membership.ready)).then(
          () =>
            replayHistory().catch((err) => {
              // The details stay in the server log.
              logger.error("⚠️ Error replaying history:", err)

              const errorEvent: SystemEvent = {
                type: "error",
                error: "Failed to replay missed events.",
              }

              safeEnqueue(encodeFrame(errorEvent))
              abandon()
            }),
          (err) => {
            logger.error("⚠️ Error subscribing:", err)

            const errorEvent: SystemEvent = { type: "error", error: "Failed to subscribe." }

            safeEnqueue(encodeFrame(errorEvent))
            abandon()
          }
        )
      },

      cancel() {
        cleanup?.()
      },
    })

    return new StreamingResponse(stream)
  }
}

export function json(data: SystemEvent | UserEvent) {
  return encodeFrame(data)
}

export class StreamingResponse extends Response {
  constructor(res: ReadableStream<any>, init?: ResponseInit) {
    super(res, {
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

import type { Redis } from "@upstash/redis"
import {
  systemEvent,
  userEvent,
  type SystemEvent,
  type UserEvent,
} from "../shared/types.js"
import { startKeepalive, type Keepalive } from "./keepalive.js"
import { InvalidChannelError, isSubscribableChannel, streamOrder } from "./utils.js"

type Logger = {
  log: (...args: any[]) => void
  error: (...args: any[]) => void
}

/** A message from a channel, validated and encoded as an SSE frame once. */
export type ChannelMessage =
  | { type: "system"; event: SystemEvent; frame: Uint8Array }
  | {
      type: "user"
      event: UserEvent
      frame: Uint8Array
      /** The event's stream position, comparable with `<=`. */
      order: string
    }

export type ChannelListener = {
  onMessage: (message: ChannelMessage) => void
  /**
   * The shared subscription stopped receiving after it had been established.
   * `aliveAt` is the last time something arrived on it.
   */
  onClose: (aliveAt: number) => void
}

export type ChannelMembership = {
  /**
   * Resolves once the channel is subscribed. Rejects if the subscription
   * could not be established.
   */
  ready: Promise<void>
  leave: () => void
}

type Subscription = {
  channel: string
  subscriber: ReturnType<Redis["subscribe"]>
  listeners: Set<ChannelListener>
  /** Listeners whose connection relies on this channel's pings to stay open. */
  heartbeats: number
  ready: Promise<void>
  keepalive: Keepalive | undefined
  connectTimer: ReturnType<typeof setTimeout> | undefined
  isClosed: boolean
}

export type ChannelHubOptions = {
  /** Silence after which a channel that keeps a connection open is pinged. */
  idleMs?: number
  /**
   * Silence after which any other channel is pinged. It only has to keep the
   * subscription from idling out and to notice, eventually, that it died.
   */
  backgroundIdleMs?: number
  jitterMs?: number
  echoTimeoutMs?: number
  retryMs?: number
  /** How long Redis may take to confirm a new subscription. */
  connectTimeoutMs?: number
}

const IDLE_MS = 55_000
// Below the five minutes after which HTTP clients give up on a silent stream.
const BACKGROUND_IDLE_MS = 240_000
const CONNECT_TIMEOUT_MS = 10_000

const encoder = new TextEncoder()

export function encodeFrame(event: SystemEvent | UserEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
}

/**
 * Shares one Redis subscription per channel between every SSE connection an
 * instance is serving.
 *
 * Without it each connection opens its own subscription, so an event on a
 * channel with N connections is received, parsed, validated and encoded N
 * times. Here that work happens once and the encoded frame is handed to each
 * connection.
 */
export class ChannelHub {
  private readonly subscriptions = new Map<string, Subscription>()

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly options: ChannelHubOptions = {}
  ) {}

  /**
   * `isHeartbeat` marks the one channel whose pings keep the caller's client
   * from timing out. Channels nobody relies on that way are pinged far less
   * often.
   */
  join(
    channel: string,
    listener: ChannelListener,
    { isHeartbeat = false }: { isHeartbeat?: boolean } = {}
  ): ChannelMembership {
    const subscription = this.subscriptions.get(channel) ?? this.open(channel)
    subscription.listeners.add(listener)

    if (isHeartbeat) {
      subscription.heartbeats += 1
      if (subscription.heartbeats === 1) subscription.keepalive?.refresh()
    }

    let hasLeft = false

    return {
      ready: subscription.ready,
      leave: () => {
        if (hasLeft) return
        hasLeft = true

        subscription.listeners.delete(listener)
        if (isHeartbeat) subscription.heartbeats -= 1
        if (subscription.listeners.size === 0) this.close(subscription)
      },
    }
  }

  private open(channel: string): Subscription {
    if (!isSubscribableChannel(channel)) throw new InvalidChannelError(channel)

    const subscriber = this.redis.subscribe(channel)
    let resolve!: () => void
    let reject!: (error: Error) => void
    const ready = new Promise<void>((onReady, onFailed) => {
      resolve = onReady
      reject = onFailed
    })
    // Each connection handles the rejection it awaits; this keeps a failed
    // subscription that nobody is waiting on from surfacing as unhandled.
    ready.catch(() => {})

    const subscription: Subscription = {
      channel,
      subscriber,
      listeners: new Set(),
      heartbeats: 0,
      ready,
      keepalive: undefined,
      connectTimer: undefined,
      isClosed: false,
    }

    // The subscription never came up. Drop it so the next connection retries
    // instead of joining a dead one.
    const fail = (error: Error) => {
      if (subscription.isClosed || subscription.keepalive) return
      this.close(subscription)
      reject(error)
    }

    // The SDK reports nothing when the subscribe request returns without
    // confirming, so without a deadline everyone joining would wait forever.
    subscription.connectTimer = setTimeout(() => {
      this.logger.error("⚠️ Redis subscription was not confirmed in time:", { channel })
      fail(new Error("Subscription timed out."))
    }, this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS)

    subscriber.on("subscribe", () => {
      if (subscription.isClosed || subscription.keepalive) return
      clearTimeout(subscription.connectTimer)

      const { idleMs = IDLE_MS, backgroundIdleMs = BACKGROUND_IDLE_MS } = this.options

      subscription.keepalive = startKeepalive({
        ...this.options,
        idleMs: () => (subscription.heartbeats > 0 ? idleMs : backgroundIdleMs),
        ping: () => this.redis.publish(channel, { type: "ping", timestamp: Date.now() }),
        onUnresponsive: () => {
          this.logger.error("⚠️ Redis subscription stopped receiving:", { channel })

          const aliveAt = subscription.keepalive?.lastArrivalAt() ?? Date.now()
          const listeners = [...subscription.listeners]
          this.close(subscription)
          for (const listener of listeners) listener.onClose(aliveAt)
        },
      })
      resolve()
    })

    subscriber.on("message", ({ channel: source, message }) => {
      // A subscription only passes on what was published on its own channel.
      if (source !== channel) return

      const decoded = this.decode(message)

      if (!decoded) {
        // Proof that the subscription works, but nothing a client will see.
        // Clients still need a ping, so this must not postpone one.
        subscription.keepalive?.alive()
        return
      }

      subscription.keepalive?.touch()
      this.dispatch(subscription, decoded)
    })

    subscriber.on("error", (error) => {
      this.logger.error("⚠️ Redis subscriber error:", error)

      if (!subscription.keepalive) {
        fail(error instanceof Error ? error : new Error("Subscription failed."))
        return
      }

      // The details stay in the server log.
      const event: SystemEvent = { type: "error", error: "Subscription error." }
      this.dispatch(subscription, { type: "system", event, frame: encodeFrame(event) })
    })

    // Redis does not end these subscriptions with an "unsubscribe", so the
    // SDK's event of that name is not acted on. A subscription that stopped
    // receiving is caught by the keepalive.

    this.subscriptions.set(channel, subscription)
    return subscription
  }

  private close(subscription: Subscription) {
    if (subscription.isClosed) return
    subscription.isClosed = true
    clearTimeout(subscription.connectTimer)
    subscription.keepalive?.stop()
    subscription.listeners.clear()

    if (this.subscriptions.get(subscription.channel) === subscription) {
      this.subscriptions.delete(subscription.channel)
    }

    subscription.subscriber.unsubscribe().catch((error) => {
      this.logger.error("⚠️ Error closing connection:", error)
    })
  }

  private dispatch(subscription: Subscription, message: ChannelMessage) {
    for (const listener of subscription.listeners) {
      try {
        listener.onMessage(message)
      } catch (error) {
        this.logger.error("⚠️ Error delivering message:", error)
      }
    }
  }

  private decode(message: unknown): ChannelMessage | undefined {
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

    const system = systemEvent.safeParse(payload)
    if (system.success) {
      return { type: "system", event: system.data, frame: encodeFrame(system.data) }
    }

    this.logger.log("⬇️  Received event:", payload)

    const user = userEvent.safeParse(payload)
    if (user.success) {
      return {
        type: "user",
        event: user.data,
        frame: encodeFrame(user.data),
        order: streamOrder(user.data.id),
      }
    }

    return undefined
  }
}

const hubs = new WeakMap<Redis, ChannelHub>()

/**
 * Cloudflare Workers and the Vercel Edge runtime end a request's pending I/O
 * together with the request. A subscription opened while serving one request
 * would stop receiving as soon as that request finished, so it cannot be
 * shared with other requests there.
 */
function isRequestScopedRuntime(): boolean {
  const runtime = globalThis as { EdgeRuntime?: unknown; navigator?: { userAgent?: string } }

  return (
    typeof runtime.EdgeRuntime === "string" ||
    runtime.navigator?.userAgent === "Cloudflare-Workers"
  )
}

/**
 * Returns the hub that shares subscriptions made through this Redis client,
 * or a hub of its own for the calling request where sharing is not possible.
 */
export function getChannelHub(redis: Redis, logger: Logger): ChannelHub {
  if (isRequestScopedRuntime()) return new ChannelHub(redis, logger)

  let hub = hubs.get(redis)
  if (!hub) {
    hub = new ChannelHub(redis, logger)
    hubs.set(redis, hub)
  }
  return hub
}

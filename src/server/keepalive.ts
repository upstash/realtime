// Idle time is measured on the monotonic clock, like the timers it is compared
// with. A wall clock that gets adjusted must not delay or trigger pings.
const now = () => performance.now()

const IDLE_MS = 55_000
const JITTER_MS = 5_000
const ECHO_TIMEOUT_MS = 10_000
const PING_TIMEOUT_MS = 10_000
const RETRY_MS = 5_000

export type KeepaliveOptions = {
  /** Publishes a ping on the channel. */
  ping: () => Promise<unknown>
  /**
   * Called when a ping was published but nothing arrived on the subscription
   * afterwards, which means the subscription is no longer receiving.
   */
  onUnresponsive?: () => void
  /**
   * How long the subscription may go without delivering anything before it is
   * pinged. A function is read every time, so the period can change while the
   * keepalive runs.
   */
  idleMs?: number | (() => number)
  jitterMs?: number
  echoTimeoutMs?: number
  /** How long a ping may take to publish before it counts as failed. */
  pingTimeoutMs?: number
  retryMs?: number
}

export type Keepalive = {
  /** Records that something was received and passed on to subscribers. */
  touch: () => void
  /**
   * Records that something was received but not passed on. It proves the
   * subscription works without counting as a sign of life for subscribers.
   */
  alive: () => void
  /** Wall-clock time of the last arrival, in milliseconds since the epoch. */
  lastArrivalAt: () => number
  /** Applies an `idleMs` that has become shorter without waiting out the old one. */
  refresh: () => void
  stop: () => void
}

/**
 * Keeps a channel subscription warm by pinging only when the channel has been
 * silent.
 *
 * Whatever the channel delivers is a sign of life for its subscribers,
 * including events and pings from other subscribers. So a channel needs about
 * one ping per idle period in total, rather than one per subscriber. The
 * jitter spreads subscribers out so the first ping resets the others before
 * they fire.
 */
export function startKeepalive({
  ping,
  onUnresponsive,
  idleMs = IDLE_MS,
  jitterMs = JITTER_MS,
  echoTimeoutMs = ECHO_TIMEOUT_MS,
  pingTimeoutMs = PING_TIMEOUT_MS,
  retryMs = RETRY_MS,
}: KeepaliveOptions): Keepalive {
  let lastDelivery = now()
  let lastArrival = lastDelivery
  let isStopped = false
  let isWaiting = false
  let failures = 0
  let jitter = Math.random() * jitterMs
  let timer: ReturnType<typeof setTimeout> | undefined

  const threshold = () => (typeof idleMs === "function" ? idleMs() : idleMs) + jitter

  /** Checks again after `delay`, unless something reschedules it first. */
  const wait = (delay: number) => {
    if (isStopped) return
    isWaiting = true
    timer = setTimeout(tick, delay)
  }

  const tick = () => {
    isWaiting = false

    const idleFor = now() - lastDelivery
    const limit = threshold()

    if (idleFor < limit) {
      wait(limit - idleFor)
      return
    }

    jitter = Math.random() * jitterMs
    const pingedAt = now()
    let isSettled = false

    const onPublished = () => {
      if (isSettled) return
      isSettled = true
      clearTimeout(timer)
      failures = 0

      if (!onUnresponsive) {
        wait(threshold())
        return
      }

      if (isStopped) return

      // The echo is awaited from the moment Redis accepted the ping, so a
      // slow publish is not mistaken for a dead subscription.
      timer = setTimeout(() => {
        if (lastArrival < pingedAt) onUnresponsive()
        if (!isStopped) tick()
      }, echoTimeoutMs)
    }

    // The ping did not reach Redis, which says nothing about the
    // subscription. Subscribers are still waiting for one and give up some
    // seconds after the idle period, so the first retries come quickly. After
    // that it backs off while Redis keeps failing.
    const onFailed = () => {
      if (isSettled) return
      isSettled = true
      clearTimeout(timer)
      failures += 1

      const backoff = retryMs * 2 ** Math.max(0, failures - 3) * (1 + Math.random() * 0.2)
      wait(Math.min(backoff, threshold()))
    }

    // A publish that never settles must not end the keepalive.
    if (!isStopped) timer = setTimeout(onFailed, pingTimeoutMs)

    Promise.resolve().then(ping).then(onPublished, onFailed)
  }

  wait(threshold())

  return {
    touch: () => {
      lastDelivery = lastArrival = now()
    },
    alive: () => {
      lastArrival = now()
    },
    lastArrivalAt: () => Math.round(Date.now() - (now() - lastArrival)),
    refresh: () => {
      if (!isWaiting) return
      clearTimeout(timer)
      tick()
    },
    stop: () => {
      isStopped = true
      clearTimeout(timer)
    },
  }
}

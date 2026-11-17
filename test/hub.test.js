import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"

import { ChannelHub } from "../src/server/hub.js"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const logger = { log() {}, error() {} }
const decode = (frame) => new TextDecoder().decode(frame)

// Like the SDK subscriber: unsubscribing aborts the stream without emitting.
class FakeSubscriber extends EventEmitter {
  unsubscribeCalls = 0

  async unsubscribe() {
    this.unsubscribeCalls += 1
  }
}

function setup(options) {
  const subscribers = []
  const published = []
  const redis = {
    subscribe(channel) {
      const subscriber = new FakeSubscriber()
      subscriber.channel = channel
      subscribers.push(subscriber)
      return subscriber
    },
    async publish(...args) {
      published.push(args)
      return 1
    },
  }

  return { subscribers, published, hub: new ChannelHub(redis, logger, options) }
}

function listen() {
  const messages = []
  const closes = []
  return {
    messages,
    closes,
    listener: {
      onMessage: (message) => messages.push(message),
      onClose: (aliveAt) => closes.push(aliveAt),
    },
  }
}

const event = { id: "1-0", data: { text: "hi" }, event: "message", channel: "room" }

test("shares one subscription between everyone on a channel", async () => {
  const { hub, subscribers } = setup()
  const first = listen()
  const second = listen()

  const a = hub.join("room", first.listener)
  const b = hub.join("room", second.listener)
  hub.join("other", listen().listener)

  expect(subscribers.map((subscriber) => subscriber.channel)).toEqual(["room", "other"])

  subscribers[0].emit("subscribe", 1)
  await Promise.all([a.ready, b.ready])

  subscribers[0].emit("message", { channel: "room", message: event })

  expect(first.messages).toHaveLength(1)
  expect(first.messages[0].type).toBe("user")
  expect(first.messages[0].order).toBe("0000000000000000000100000000000000000000")
  expect(decode(first.messages[0].frame)).toBe(`data: ${JSON.stringify(event)}\n\n`)
  // Validated and encoded once: both listeners get the very same message.
  expect(second.messages[0]).toBe(first.messages[0])
})

test("classifies system events and drops anything else", async () => {
  const { hub, subscribers } = setup()
  const { listener, messages } = listen()

  hub.join("room", listener)
  subscribers[0].emit("subscribe", 1)

  subscribers[0].emit("message", { channel: "room", message: { type: "ping", timestamp: 1 } })
  subscribers[0].emit("message", { channel: "room", message: "not json" })
  subscribers[0].emit("message", { channel: "room", message: { ...event, id: "invalid" } })
  subscribers[0].emit("message", { channel: "room", message: { ...event, extra: true } })

  expect(messages.map((message) => message.type)).toEqual(["system", "user"])
  expect(messages[1].event).toEqual(event)
})

test("ignores messages from any channel other than the one joined", async () => {
  const { hub, subscribers } = setup()
  const { listener, messages } = listen()

  hub.join("mine", listener)
  subscribers[0].emit("subscribe", 1)

  subscribers[0].emit("message", { channel: "other", message: { ...event, channel: "other" } })
  subscribers[0].emit("message", { channel: "other", message: { ...event, channel: "mine" } })
  subscribers[0].emit("message", { channel: "other", message: { type: "ping", timestamp: 1 } })

  expect(messages).toHaveLength(0)

  subscribers[0].emit("message", { channel: "mine", message: { ...event, channel: "mine" } })

  expect(messages).toHaveLength(1)
})

test("unsubscribes when the last listener leaves and resubscribes on demand", async () => {
  const { hub, subscribers } = setup()

  const a = hub.join("room", listen().listener)
  const b = hub.join("room", listen().listener)
  subscribers[0].emit("subscribe", 1)

  a.leave()
  expect(subscribers[0].unsubscribeCalls).toBe(0)

  b.leave()
  b.leave()
  expect(subscribers[0].unsubscribeCalls).toBe(1)

  hub.join("room", listen().listener)
  expect(subscribers).toHaveLength(2)
})

test("a listener that left receives nothing more", async () => {
  const { hub, subscribers } = setup()
  const gone = listen()
  const staying = listen()

  const membership = hub.join("room", gone.listener)
  hub.join("room", staying.listener)
  subscribers[0].emit("subscribe", 1)
  membership.leave()

  subscribers[0].emit("message", { channel: "room", message: event })

  expect(gone.messages).toHaveLength(0)
  expect(staying.messages).toHaveLength(1)
})

test("a subscription that fails to start is retried by the next join", async () => {
  const { hub, subscribers } = setup()
  const failure = new Error("fetch failed")

  const membership = hub.join("room", listen().listener)
  subscribers[0].emit("error", failure)

  await expect(membership.ready).rejects.toBe(failure)
  expect(subscribers[0].unsubscribeCalls).toBe(1)

  const retry = hub.join("room", listen().listener)
  expect(subscribers).toHaveLength(2)

  subscribers[1].emit("subscribe", 1)
  await retry.ready
})

test("forwards an error on an established subscription and keeps it", async () => {
  const { hub, subscribers } = setup()
  const { listener, messages, closes } = listen()

  hub.join("room", listener)
  subscribers[0].emit("subscribe", 1)
  subscribers[0].emit("error", new Error("Failed to parse message: some payload text"))

  // Clients get a fixed message; the details are only logged.
  expect(messages.map((message) => message.event)).toEqual([
    { type: "error", error: "Subscription error." },
  ])
  expect(closes).toHaveLength(0)
  expect(subscribers[0].unsubscribeCalls).toBe(0)
})

test("pings an idle channel once, however many listeners it has", async () => {
  const { hub, subscribers, published } = setup({ idleMs: 30, jitterMs: 0, echoTimeoutMs: 500 })

  for (let index = 0; index < 5; index++) {
    hub.join("room", listen().listener, { isHeartbeat: true })
  }
  subscribers[0].emit("subscribe", 1)

  await sleep(60)

  expect(published).toHaveLength(1)
  expect(published[0][0]).toBe("room")
  expect(published[0][1].type).toBe("ping")
})

test("closes a subscription that stops receiving", async () => {
  const { hub, subscribers } = setup({ idleMs: 20, jitterMs: 0, echoTimeoutMs: 20 })
  const { listener, closes } = listen()

  const membership = hub.join("room", listener, { isHeartbeat: true })
  subscribers[0].emit("subscribe", 1)
  await membership.ready
  const subscribedAt = Date.now()

  // The ping is published but never comes back.
  await sleep(80)

  expect(closes).toHaveLength(1)
  expect(Math.abs(closes[0] - subscribedAt)).toBeLessThan(15)
  expect(subscribers[0].unsubscribeCalls).toBe(1)

  hub.join("room", listen().listener)
  expect(subscribers).toHaveLength(2)
})

test("does not act on an unsubscribe reported by the SDK", async () => {
  const { hub, subscribers } = setup()
  const { listener, closes, messages } = listen()

  hub.join("room", listener)
  subscribers[0].emit("subscribe", 1)
  subscribers[0].emit("unsubscribe", 0)
  subscribers[0].emit("message", { channel: "room", message: event })

  expect(closes).toHaveLength(0)
  expect(messages).toHaveLength(1)
  expect(subscribers[0].unsubscribeCalls).toBe(0)
})

test("gives up on a subscription Redis never confirms, and retries on the next join", async () => {
  const { hub, subscribers } = setup({ connectTimeoutMs: 20 })

  const first = hub.join("room", listen().listener)
  const second = hub.join("room", listen().listener)
  const outcomes = Promise.allSettled([first.ready, second.ready])

  await sleep(50)

  expect((await outcomes).map((outcome) => outcome.status)).toEqual(["rejected", "rejected"])
  expect(subscribers[0].unsubscribeCalls).toBe(1)

  // Everyone waiting was let go, and the channel is not stuck on the dead one.
  const retry = hub.join("room", listen().listener)
  expect(subscribers).toHaveLength(2)
  subscribers[1].emit("subscribe", 1)
  await retry.ready

  // A confirmed subscription is not timed out afterwards.
  await sleep(50)
  expect(subscribers[1].unsubscribeCalls).toBe(0)
})

test("pings a channel no connection relies on far less often", async () => {
  const { hub, subscribers, published } = setup({
    idleMs: 20,
    backgroundIdleMs: 200,
    jitterMs: 0,
    echoTimeoutMs: 1000,
  })

  hub.join("background", listen().listener)
  hub.join("heartbeat", listen().listener, { isHeartbeat: true })
  for (const subscriber of subscribers) subscriber.emit("subscribe", 1)

  await sleep(80)

  expect(published.map(([channel]) => channel)).toEqual(["heartbeat"])
})

test("pings sooner once a connection starts relying on the channel", async () => {
  const { hub, subscribers, published } = setup({
    idleMs: 30,
    backgroundIdleMs: 10_000,
    jitterMs: 0,
    echoTimeoutMs: 1000,
  })

  hub.join("room", listen().listener)
  subscribers[0].emit("subscribe", 1)
  await sleep(40)
  expect(published).toHaveLength(0)

  const membership = hub.join("room", listen().listener, { isHeartbeat: true })
  await sleep(20)
  expect(published).toHaveLength(1)

  // And goes back to the slow period when that connection leaves.
  membership.leave()
  membership.leave()
  subscribers[0].emit("message", { channel: "room", message: event })
  await sleep(60)
  expect(published).toHaveLength(1)
})

test("refuses channel names the Redis SDK cannot subscribe to", () => {
  const { hub, subscribers } = setup()
  const unsupported = ["", ".", "..", "a/b", "a\\b", "a?b", "a#b", "100%", "a%20b", "trailing ", "tab\tinside", "line\nbreak", "\ud800"]

  for (const name of unsupported) {
    expect(() => hub.join(name, listen().listener)).toThrow("Cannot subscribe to channel")
  }
  expect(subscribers).toHaveLength(0)

  const supported = ["room", "org:1-team_2", "a.b.c", "my room", " leading", "żółć-日本語", "room-😀", 'ro"om{1}[2]', "a+b&c=d", "user@host~*", "a;b|c", "..."]
  for (const name of supported) hub.join(name, listen().listener)
  expect(subscribers.map((subscriber) => subscriber.channel)).toEqual(supported)
})

test("a listener may leave from inside its own callback", async () => {
  const { hub, subscribers } = setup()
  const after = listen()
  let membership
  let calls = 0

  membership = hub.join("room", {
    onMessage: () => {
      calls += 1
      membership.leave()
    },
    onClose: () => {},
  })
  hub.join("room", after.listener)
  subscribers[0].emit("subscribe", 1)

  subscribers[0].emit("message", { channel: "room", message: event })
  subscribers[0].emit("message", { channel: "room", message: { ...event, id: "2-0" } })

  expect(calls).toBe(1)
  expect(after.messages).toHaveLength(2)
  expect(subscribers[0].unsubscribeCalls).toBe(0)
})

test("a throwing listener does not stop delivery to the others", async () => {
  const { hub, subscribers } = setup()
  const after = listen()

  hub.join("room", {
    onMessage: () => {
      throw new Error("listener failed")
    },
    onClose: () => {},
  })
  hub.join("room", after.listener)
  subscribers[0].emit("subscribe", 1)
  subscribers[0].emit("message", { channel: "room", message: event })

  expect(after.messages).toHaveLength(1)
})

test("joining again while a lost subscription is being torn down gets a fresh one", async () => {
  const { hub, subscribers } = setup({ idleMs: 15, jitterMs: 0, echoTimeoutMs: 15 })
  let rejoined

  hub.join(
    "room",
    {
      onMessage: () => {},
      // What a reconnecting client effectively does: join again right away.
      onClose: () => {
        rejoined = hub.join("room", listen().listener)
      },
    },
    { isHeartbeat: true }
  )
  subscribers[0].emit("subscribe", 1)
  // The ping is never echoed, so the subscription is declared lost.
  await sleep(60)

  expect(subscribers).toHaveLength(2)
  expect(subscribers[0].unsubscribeCalls).toBe(1)

  subscribers[1].emit("subscribe", 1)
  await rejoined.ready

  // Late events from the old subscriber no longer reach anyone.
  const late = listen()
  hub.join("room", late.listener)
  subscribers[0].emit("message", { channel: "room", message: event })
  expect(late.messages).toHaveLength(0)
})

test("leaves no subscriptions or timers behind after many joins and leaves", async () => {
  const { hub, subscribers } = setup({ idleMs: 10_000 })
  const active = new Set()
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (handler, timeout, ...args) => {
    const handle = originalSetTimeout(handler, timeout, ...args)
    if (timeout >= 1000) active.add(handle)
    return handle
  }
  globalThis.clearTimeout = (handle) => {
    active.delete(handle)
    return originalClearTimeout(handle)
  }

  try {
    for (let round = 0; round < 50; round++) {
      const memberships = Array.from({ length: 4 }, (_, index) =>
        hub.join(`room-${index % 2}`, listen().listener)
      )
      for (const subscriber of subscribers.slice(-2)) subscriber.emit("subscribe", 1)
      for (const membership of memberships) membership.leave()
    }

    expect(hub.subscriptions.size).toBe(0)
    expect(active.size).toBe(0)
    expect(subscribers).toHaveLength(100)
    expect(subscribers.every((subscriber) => subscriber.unsubscribeCalls === 1)).toBe(true)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})

test("traffic that no client will see does not postpone the ping they are waiting for", async () => {
  const { hub, subscribers, published } = setup({ idleMs: 40, jitterMs: 0, echoTimeoutMs: 25 })
  const { listener, messages, closes } = listen()

  hub.join("room", listener, { isHeartbeat: true })
  subscribers[0].emit("subscribe", 1)

  // Something else publishes on the channel in a shape that is not forwarded.
  const foreign = setInterval(() => {
    subscribers[0].emit("message", { channel: "room", message: "not a realtime event" })
  }, 10)

  await sleep(100)
  clearInterval(foreign)

  expect(messages).toHaveLength(0)
  expect(published.length).toBeGreaterThanOrEqual(1)
  // It does prove the subscription works, so the unanswered ping is not
  // taken for a dead subscription.
  expect(closes).toHaveLength(0)
})

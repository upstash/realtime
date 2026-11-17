import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"

import { Realtime, handle } from "../src/server/index.js"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// Like the SDK subscriber: unsubscribing aborts the stream without emitting.
class FakeSubscriber extends EventEmitter {
  unsubscribeCalls = 0

  async unsubscribe() {
    this.unsubscribeCalls += 1
  }
}

function setup({ history = {}, historyError, middleware } = {}) {
  const subscribers = []
  const rangeCalls = []
  const published = []
  let releaseHistory = () => {}
  const historyReleased = new Promise((resolve) => (releaseHistory = resolve))

  const redis = {
    subscribe(channel) {
      const subscriber = new FakeSubscriber()
      subscriber.channel = channel
      subscribers.push(subscriber)
      return subscriber
    },
    pipeline() {
      const commands = []
      return {
        xrange(...args) {
          commands.push(args)
        },
        async exec() {
          rangeCalls.push(commands)
          await historyReleased
          if (historyError) throw historyError
          return commands.map(([channel]) => history[channel] ?? {})
        },
      }
    },
    async publish(...args) {
      published.push(args)
      return 1
    },
  }

  const handler = handle({ realtime: new Realtime({ redis }), ...(middleware && { middleware }) })

  const connect = async (query = "channel=room&last_ack_room=1-0") => {
    const abort = new AbortController()
    const response = await handler(
      new Request(`http://localhost/api/realtime?${query}`, { signal: abort.signal })
    )
    const frames = []
    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    const closed = (async () => {
      while (true) {
        const { value, done } = await reader.read()
        if (done) return
        for (const frame of decoder.decode(value).split("\n\n").filter(Boolean)) {
          frames.push(JSON.parse(frame.slice("data: ".length)))
        }
      }
    })()

    return { frames, closed, abort: () => abort.abort(), response }
  }

  const publish = (channel, message) => {
    for (const subscriber of subscribers) {
      if (subscriber.channel === channel) subscriber.emit("message", { channel, message })
    }
  }

  return { connect, publish, subscribers, rangeCalls, published, releaseHistory, handler }
}

const event = (id, data, channel = "room") => ({ id, data, event: "message", channel })
const stored = ({ id, ...fields }) => [id, fields]

test("replays missed events, then buffered events, then live ones", async () => {
  const history = { room: Object.fromEntries([event("5-0", 1), event("6-0", 2)].map(stored)) }
  const { connect, publish, subscribers, rangeCalls, releaseHistory } = setup({ history })

  const client = await connect()
  subscribers[0].emit("subscribe", 1)
  await tick()

  // Arrives while the replay is in flight: one copy of a replayed event and
  // one new event.
  publish("room", event("6-0", 2))
  publish("room", event("7-0", 3))
  publish("room", { type: "ping", timestamp: 1 })

  releaseHistory()
  await tick()
  publish("room", event("8-0", 4))
  await tick()

  expect(rangeCalls).toEqual([[["room", "(1-0", "+"]]])
  expect(client.frames).toEqual([
    { type: "connected", channel: "room" },
    { type: "ping", timestamp: 1 },
    event("5-0", 1),
    event("6-0", 2),
    event("7-0", 3),
    event("8-0", 4),
  ])

  client.abort()
})

test("drops a live copy of a replayed event that arrives after the replay", async () => {
  const history = { room: Object.fromEntries([event("5-0", 1)].map(stored)) }
  const { connect, publish, subscribers, releaseHistory } = setup({ history })

  const client = await connect()
  subscribers[0].emit("subscribe", 1)
  releaseHistory()
  await tick()

  publish("room", event("5-0", 1))
  publish("room", event("6-0", 2))
  await tick()

  expect(client.frames.slice(1)).toEqual([event("5-0", 1), event("6-0", 2)])

  client.abort()
})

test("replays every channel of a connection in one round trip", async () => {
  const history = {
    a: Object.fromEntries([event("5-0", 1, "a")].map(stored)),
    b: Object.fromEntries([event("5-1", 2, "b")].map(stored)),
  }
  const { connect, subscribers, rangeCalls, releaseHistory } = setup({ history })

  const client = await connect("channel=a&channel=b&last_ack_a=1-0&last_ack_b=2-0")
  subscribers[0].emit("subscribe", 1)
  await tick()
  expect(client.frames).toEqual([])

  subscribers[1].emit("subscribe", 1)
  releaseHistory()
  await tick()

  expect(rangeCalls).toEqual([
    [
      ["a", "(1-0", "+"],
      ["b", "(2-0", "+"],
    ],
  ])
  expect(client.frames).toEqual([
    { type: "connected", channel: "a" },
    { type: "connected", channel: "b" },
    event("5-0", 1, "a"),
    event("5-1", 2, "b"),
  ])

  client.abort()
})

test("connections on the same channel share one subscription", async () => {
  const { connect, publish, subscribers, releaseHistory } = setup()
  releaseHistory()

  const first = await connect()
  subscribers[0].emit("subscribe", 1)
  const second = await connect()
  await tick()

  expect(subscribers).toHaveLength(1)

  publish("room", event("5-0", 1))
  await tick()

  expect(first.frames).toEqual([{ type: "connected", channel: "room" }, event("5-0", 1)])
  expect(second.frames).toEqual(first.frames)

  first.abort()
  await tick()
  expect(subscribers[0].unsubscribeCalls).toBe(0)

  publish("room", event("6-0", 2))
  await tick()
  expect(second.frames).toHaveLength(3)

  second.abort()
  await tick()
  expect(subscribers[0].unsubscribeCalls).toBe(1)
})

test("keeps subscriptions per request where requests cannot share I/O", async () => {
  globalThis.EdgeRuntime = "edge-runtime"

  try {
    const { connect, publish, subscribers, releaseHistory } = setup()
    releaseHistory()

    const first = await connect()
    const second = await connect()
    expect(subscribers).toHaveLength(2)

    for (const subscriber of subscribers) subscriber.emit("subscribe", 1)
    await tick()
    publish("room", event("5-0", 1))
    await tick()

    expect(first.frames).toEqual([{ type: "connected", channel: "room" }, event("5-0", 1)])
    expect(second.frames).toEqual(first.frames)

    first.abort()
    await tick()
    expect(subscribers.map((subscriber) => subscriber.unsubscribeCalls)).toEqual([1, 0])

    second.abort()
  } finally {
    delete globalThis.EdgeRuntime
  }
})

test("does not publish a ping per connection", async () => {
  const { connect, subscribers, published, releaseHistory } = setup()
  releaseHistory()

  const clients = [await connect(), await connect(), await connect()]
  subscribers[0].emit("subscribe", 1)
  await tick()

  expect(published).toHaveLength(0)

  for (const client of clients) client.abort()
})

test("a failed replay delivers nothing more and leaves the stream open", async () => {
  const { connect, publish, subscribers, releaseHistory } = setup({
    historyError: new Error("WRONGTYPE"),
  })

  const client = await connect()
  let isClosed = false
  client.closed.then(() => (isClosed = true))
  subscribers[0].emit("subscribe", 1)
  publish("room", event("5-0", 1))
  releaseHistory()
  await tick()
  publish("room", event("6-0", 2))
  await tick()

  // The Redis error itself is logged, not sent to the client. Events are
  // withheld rather than delivered with a gap; the client's ping timeout
  // makes it reconnect and replay. Closing would make browsers retry in a
  // tight loop.
  expect(client.frames).toEqual([
    { type: "connected", channel: "room" },
    { type: "error", error: "Failed to replay missed events." },
  ])
  expect(isClosed).toBe(false)
  expect(subscribers[0].unsubscribeCalls).toBe(1)

  client.abort()
})

test("reports a subscription that could not be established", async () => {
  const { connect, subscribers } = setup()

  const client = await connect()
  subscribers[0].emit("error", new Error("fetch failed"))
  await tick()

  // The cause is logged, not sent to the client.
  expect(client.frames).toEqual([{ type: "error", error: "Failed to subscribe." }])

  // The next connection gets a fresh subscription instead of the failed one.
  const retry = await connect()
  expect(subscribers).toHaveLength(2)

  client.abort()
  retry.abort()
})

// Runs timers and both clocks `scale` times faster, so the minute-long
// keepalive period fits into a test.
async function withFastClock(scale, run) {
  const realSetTimeout = globalThis.setTimeout
  const realNow = performance.now.bind(performance)
  const realDateNow = Date.now
  const startedAt = realNow()
  const startedAtWallClock = realDateNow()
  const elapsed = () => (realNow() - startedAt) * scale

  globalThis.setTimeout = (handler, delay = 0, ...args) =>
    realSetTimeout(handler, delay / scale, ...args)
  performance.now = () => startedAt + elapsed()
  Date.now = () => Math.round(startedAtWallClock + elapsed())

  try {
    return await run((ms) => new Promise((resolve) => realSetTimeout(resolve, ms)))
  } finally {
    globalThis.setTimeout = realSetTimeout
    performance.now = realNow
    Date.now = realDateNow
  }
}

test("asks the client to reconnect when the subscription stops receiving", async () => {
  await withFastClock(1000, async (realSleep) => {
    const { connect, publish, subscribers, published, releaseHistory } = setup()
    releaseHistory()

    const client = await connect()
    subscribers[0].emit("subscribe", 1)
    await realSleep(5)
    publish("room", event("5-0", 1))
    const lastArrival = Date.now()

    // A minute of silence: the channel is pinged, the ping never comes back.
    await client.closed

    expect(published.map(([channel, message]) => [channel, message.type])).toEqual([["room", "ping"]])
    expect(client.frames.map((frame) => frame.type ?? "event")).toEqual([
      "connected",
      "event",
      "reconnect",
    ])
    // The client is told when the subscription was last known to work, which
    // is about a minute before it was declared lost.
    expect(Math.abs(client.frames[2].timestamp - lastArrival)).toBeLessThan(5000)
    expect(Date.now() - client.frames[2].timestamp).toBeGreaterThan(50_000)
    expect(subscribers[0].unsubscribeCalls).toBe(1)
  })
})

test("keeps the connection alive through its first channel only", async () => {
  await withFastClock(1000, async (realSleep) => {
    const { connect, publish, subscribers, published, releaseHistory } = setup()
    releaseHistory()

    const client = await connect("channel=a&channel=b&channel=c")
    for (const subscriber of subscribers) subscriber.emit("subscribe", 1)

    // Just over a minute: only the first channel needed a ping.
    await realSleep(62)
    expect(published.map(([channel]) => channel)).toEqual(["a"])
    // Echo it so the subscription is not declared lost.
    publish("a", published[0][1])
    await realSleep(5)
    expect(client.frames.at(-1).type).toBe("ping")

    client.abort()
  })
})

// Names the Redis SDK cannot subscribe to, or cannot attribute messages to.
const replayOnlyNames = ["a/b", "a?b", "a#b", "50%", "a\\b", "..", "trailing ", "a,b"]

test("serves channels it cannot subscribe to from history only", async () => {
  const seenByMiddleware = []
  const { connect, publish, subscribers, rangeCalls, releaseHistory } = setup({
    history: { "a/b": Object.fromEntries([event("4-0", 0, "a/b")].map(stored)) },
    middleware: ({ channels }) => {
      seenByMiddleware.push(channels)
    },
  })
  releaseHistory()

  for (const name of replayOnlyNames) {
    const client = await connect(`channel=room&channel=${encodeURIComponent(name)}`)
    for (const subscriber of subscribers) subscriber.emit("subscribe", 1)
    await tick()

    // Only the other channel is subscribed to.
    expect([name, [...new Set(subscribers.map((subscriber) => subscriber.channel))]]).toEqual([
      name,
      ["room"],
    ])
    // The middleware still sees exactly what was asked for.
    expect(seenByMiddleware.at(-1)).toEqual(["room", name])
    // Missed events are replayed for both.
    expect(rangeCalls.at(-1).map(([channel]) => channel)).toEqual(["room", name])
    expect(client.frames.filter((frame) => frame.type === "connected")).toHaveLength(2)
    if (name === "a/b") expect(client.frames.at(-1)).toEqual(event("4-0", 0, "a/b"))

    publish("room", event(`${5 + replayOnlyNames.indexOf(name)}-0`, 1))
    await tick()
    expect(client.frames.at(-1).channel).toBe("room")

    client.abort()
    await tick()
  }
})

test("a request for only such a channel opens no subscription", async () => {
  const { connect, subscribers, rangeCalls, published, releaseHistory } = setup()
  releaseHistory()

  const client = await connect(`channel=${encodeURIComponent("a,b")}`)
  await tick()

  expect(subscribers).toHaveLength(0)
  expect(rangeCalls).toHaveLength(1)
  expect(published).toHaveLength(0)
  expect(client.frames).toEqual([{ type: "connected", channel: "a,b" }])

  client.abort()
})

test("does not redeliver what the client acknowledged, however late its live copy arrives", async () => {
  const { connect, publish, subscribers, releaseHistory } = setup()
  releaseHistory()

  // Nothing newer than the acknowledged event is in the stream yet.
  const client = await connect("channel=room&last_ack_room=5-0")
  subscribers[0].emit("subscribe", 1)
  await tick()

  // A shared subscription that is slightly behind still has it in flight.
  publish("room", event("5-0", 1))
  publish("room", event("4-9", 0))
  publish("room", event("6-0", 2))
  publish("room", event("5-0", 1))
  await tick()

  expect(client.frames.slice(1)).toEqual([event("6-0", 2)])

  client.abort()
})

test("a timestamp from the client's clock is not used to filter live events", async () => {
  const { connect, publish, subscribers, releaseHistory } = setup()
  releaseHistory()

  // A client whose clock runs ahead of Redis.
  const client = await connect("channel=room&last_ack_room=9999999999999")
  subscribers[0].emit("subscribe", 1)
  await tick()

  publish("room", event("1700000000000-0", 1))
  await tick()

  expect(client.frames.slice(1)).toEqual([event("1700000000000-0", 1)])

  client.abort()
})

test("copes with live events that arrive out of stream order", async () => {
  const history = { room: Object.fromEntries([event("5-0", 1)].map(stored)) }
  const { connect, publish, subscribers, releaseHistory } = setup({ history })

  const client = await connect()
  subscribers[0].emit("subscribe", 1)
  await tick()

  // An emitter on an older version can publish two concurrent emits in the
  // opposite order to their stream ids.
  publish("room", event("6-0", 2))
  publish("room", event("5-0", 1))

  releaseHistory()
  await tick()

  publish("room", event("8-0", 4))
  publish("room", event("7-0", 3))
  publish("room", event("5-0", 1))
  await tick()

  // Replayed events are never delivered twice; events that are merely late
  // are still delivered.
  expect(client.frames.slice(1)).toEqual([
    event("5-0", 1),
    event("6-0", 2),
    event("8-0", 4),
    event("7-0", 3),
  ])

  client.abort()
})

test("a client that joined a subscription which was already lost is not sent back in time", async () => {
  await withFastClock(1000, async (realSleep) => {
    const { connect, subscribers, releaseHistory } = setup()
    releaseHistory()

    const early = await connect()
    subscribers[0].emit("subscribe", 1)
    const subscribedAt = Date.now()

    // The subscription has stopped receiving, which nobody knows yet.
    await realSleep(40)
    const joinedAt = Date.now()
    const late = await connect()

    await Promise.all([early.closed, late.closed])

    const reconnectOf = (client) => client.frames.find((frame) => frame.type === "reconnect")
    // The early client resumes from when the subscription last worked.
    expect(Math.abs(reconnectOf(early).timestamp - subscribedAt)).toBeLessThan(5000)
    // The late one must not replay events from before it connected.
    expect(reconnectOf(late).timestamp).toBeGreaterThanOrEqual(joinedAt - 1000)
  })
})

test("a malformed last_ack only fails the connection that sent it", async () => {
  const { connect, publish, subscribers, releaseHistory } = setup()
  releaseHistory()

  const healthy = await connect()
  subscribers[0].emit("subscribe", 1)
  await tick()

  // Redis rejects the range; modelled here by a client whose replay throws.
  const broken = setup({ historyError: new Error("ERR Invalid stream ID") })
  const bad = await broken.connect("channel=room&last_ack_room=not-an-id")
  broken.subscribers[0].emit("subscribe", 1)
  broken.releaseHistory()
  await tick()

  publish("room", event("5-0", 1))
  await tick()

  expect(bad.frames.at(-1)).toEqual({ type: "error", error: "Failed to replay missed events." })
  expect(healthy.frames).toEqual([{ type: "connected", channel: "room" }, event("5-0", 1)])

  healthy.abort()
  bad.abort()
})

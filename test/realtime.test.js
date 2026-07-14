import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"

import { CursorUnavailableError, Realtime } from "../src/server/index.js"
import { compareStreamIds } from "../src/server/utils.js"

class FakeSubscriber extends EventEmitter {
  unsubscribeCalls = 0

  async unsubscribe() {
    this.unsubscribeCalls += 1
    this.emit("unsubscribe", 0)
  }
}

function withCursor(event) {
  return { ...event, cursor: event.id }
}

function setup({ historyEvents, historyError, subscribeOptions = { history: true } }) {
  const subscriber = new FakeSubscriber()
  const snapshotCaptured = Promise.withResolvers()
  const releaseHistory = Promise.withResolvers()
  const rangeCalls = []
  const redis = {
    subscribe() {
      return subscriber
    },
    async xrange(...args) {
      rangeCalls.push(args)
      snapshotCaptured.resolve()
      await releaseHistory.promise
      if (historyError) throw historyError

      const [, start = "-"] = args
      const selected =
        start === "-"
          ? historyEvents
          : historyEvents.filter(({ id }) => compareStreamIds(id, start) >= 0)
      return Object.fromEntries(selected.map(({ id, ...fields }) => [id, fields]))
    },
    async publish() {
      return 1
    },
  }
  const received = []
  const realtime = new Realtime({ redis })
  const subscribe = realtime.channel("updates").subscribe({
    events: ["update"],
    onData(event) {
      received.push(event)
    },
    ...subscribeOptions,
  })

  return {
    subscriber,
    snapshotCaptured,
    releaseHistory,
    subscribe,
    received,
    rangeCalls,
  }
}

async function subscribeWithDelayedHistory({ historyEvents, liveEvent }) {
  const { subscriber, snapshotCaptured, releaseHistory, subscribe, received } =
    setup({ historyEvents })

  subscriber.emit("subscribe", 1)
  await snapshotCaptured.promise

  subscriber.emit("message", { channel: "updates", message: liveEvent })

  releaseHistory.resolve()
  const unsubscribe = await subscribe
  unsubscribe()

  return received
}

test("replays history before live events received during replay", async () => {
  const historyEvent = {
    id: "1-0",
    event: "update",
    channel: "updates",
    data: { value: "history" },
  }
  const liveEvent = {
    id: "2-0",
    event: "update",
    channel: "updates",
    data: { value: "live" },
  }
  const received = await subscribeWithDelayedHistory({
    historyEvents: [historyEvent],
    liveEvent,
  })

  expect(received).toEqual([withCursor(historyEvent), withCursor(liveEvent)])
})

test("deduplicates live events already included in history", async () => {
  const event = {
    id: "2-0",
    event: "update",
    channel: "updates",
    data: { value: "overlap" },
  }
  const received = await subscribeWithDelayedHistory({
    historyEvents: [event],
    liveEvent: event,
  })

  expect(received).toEqual([withCursor(event)])
})

test("deduplicates live events that arrive after replay completes", async () => {
  const historyEvent = {
    id: "2-0",
    event: "update",
    channel: "updates",
    data: { value: "overlap" },
  }
  const freshEvent = {
    id: "3-0",
    event: "update",
    channel: "updates",
    data: { value: "fresh" },
  }
  const { subscriber, releaseHistory, subscribe, received } = setup({
    historyEvents: [historyEvent],
  })

  subscriber.emit("subscribe", 1)
  releaseHistory.resolve()
  const unsubscribe = await subscribe

  // emit runs XADD before PUBLISH, so the pub/sub copy of an event already
  // captured by the XRANGE snapshot can arrive after replay has finished.
  subscriber.emit("message", { channel: "updates", message: historyEvent })
  subscriber.emit("message", { channel: "updates", message: freshEvent })
  unsubscribe()

  expect(received).toEqual([withCursor(historyEvent), withCursor(freshEvent)])
})

test("resumes exclusively after a retained cursor", async () => {
  const events = [
    {
      id: "1-0",
      event: "update",
      channel: "updates",
      data: { value: "before" },
    },
    {
      id: "2-0",
      event: "update",
      channel: "updates",
      data: { value: "acknowledged" },
    },
    {
      id: "3-0",
      event: "update",
      channel: "updates",
      data: { value: "missed" },
    },
  ]
  const { subscriber, releaseHistory, subscribe, received, rangeCalls } = setup({
    historyEvents: events,
    subscribeOptions: { after: "2-0" },
  })

  subscriber.emit("subscribe", 1)
  releaseHistory.resolve()
  const unsubscribe = await subscribe
  unsubscribe()

  expect(rangeCalls).toEqual([["updates", "2-0", "+"]])
  expect(received).toEqual([withCursor(events[2])])
})

test("accepts a cursor from an event outside the subscription filter", async () => {
  const cursorEvent = {
    id: "2-0",
    event: "ignored",
    channel: "updates",
    data: { value: "acknowledged" },
  }
  const missedEvent = {
    id: "3-0",
    event: "update",
    channel: "updates",
    data: { value: "missed" },
  }
  const { subscriber, releaseHistory, subscribe, received } = setup({
    historyEvents: [cursorEvent, missedEvent],
    subscribeOptions: { after: cursorEvent.id },
  })

  subscriber.emit("subscribe", 1)
  releaseHistory.resolve()
  const unsubscribe = await subscribe
  unsubscribe()

  expect(received).toEqual([withCursor(missedEvent)])
})

test("adds a cursor to live events without history replay", async () => {
  const liveEvent = {
    id: "3-0",
    event: "update",
    channel: "updates",
    data: { value: "live" },
  }
  const { subscriber, subscribe, received, rangeCalls } = setup({
    historyEvents: [],
    subscribeOptions: {},
  })

  subscriber.emit("subscribe", 1)
  const unsubscribe = await subscribe
  subscriber.emit("message", { channel: "updates", message: liveEvent })
  unsubscribe()

  expect(rangeCalls).toEqual([])
  expect(received).toEqual([withCursor(liveEvent)])
})

test("does not redeliver the cursor when no events were missed", async () => {
  const acknowledged = {
    id: "2-0",
    event: "update",
    channel: "updates",
    data: { value: "acknowledged" },
  }
  const fresh = {
    id: "3-0",
    event: "update",
    channel: "updates",
    data: { value: "fresh" },
  }
  const { subscriber, releaseHistory, subscribe, received } = setup({
    historyEvents: [acknowledged],
    subscribeOptions: { after: acknowledged.id },
  })

  subscriber.emit("subscribe", 1)
  releaseHistory.resolve()
  const unsubscribe = await subscribe
  subscriber.emit("message", { channel: "updates", message: acknowledged })
  subscriber.emit("message", { channel: "updates", message: fresh })
  unsubscribe()

  expect(received).toEqual([withCursor(fresh)])
})

test("rejects a cursor that is no longer retained", async () => {
  const { subscriber, snapshotCaptured, releaseHistory, subscribe } = setup({
    historyEvents: [
      {
        id: "3-0",
        event: "update",
        channel: "updates",
        data: { value: "first retained" },
      },
    ],
    subscribeOptions: { after: "2-0" },
  })

  subscriber.emit("subscribe", 1)
  await snapshotCaptured.promise
  releaseHistory.resolve()

  const error = await subscribe.then(
    () => new Error("Expected the subscription to reject"),
    (cause) => cause
  )
  expect(error).toBeInstanceOf(CursorUnavailableError)
  expect(error).toMatchObject({ channel: "updates", cursor: "2-0" })
  expect(subscriber.unsubscribeCalls).toBe(1)
})

test("rejects after together with history", async () => {
  const { subscribe } = setup({
    historyEvents: [],
    subscribeOptions: { after: "2-0", history: true },
  })

  await expect(subscribe).rejects.toBeInstanceOf(TypeError)
})

test("rejects and cleans up when history replay fails", async () => {
  const historyError = new Error("History failed")
  const { subscriber, snapshotCaptured, releaseHistory, subscribe } = setup({
    historyEvents: [],
    historyError,
  })

  subscriber.emit("subscribe", 1)
  await snapshotCaptured.promise
  releaseHistory.resolve()

  await expect(subscribe).rejects.toBe(historyError)
  expect(subscriber.unsubscribeCalls).toBe(1)
})

test("compares the full Redis stream sequence", async () => {
  const historyEvent = {
    id: "1-9007199254740992",
    event: "update",
    channel: "updates",
    data: { value: "history" },
  }
  const liveEvent = {
    id: "1-9007199254740993",
    event: "update",
    channel: "updates",
    data: { value: "live" },
  }

  const received = await subscribeWithDelayedHistory({
    historyEvents: [historyEvent],
    liveEvent,
  })

  expect(received).toEqual([withCursor(historyEvent), withCursor(liveEvent)])
})

test("ignores live events with an invalid stream id", async () => {
  const historyEvent = {
    id: "1-0",
    event: "update",
    channel: "updates",
    data: { value: "history" },
  }
  const invalidEvent = {
    id: "invalid",
    event: "update",
    channel: "updates",
    data: { value: "invalid" },
  }
  const liveEvent = {
    id: "2-0",
    event: "update",
    channel: "updates",
    data: { value: "live" },
  }
  const { subscriber, releaseHistory, subscribe, received } = setup({
    historyEvents: [historyEvent],
  })

  subscriber.emit("subscribe", 1)
  releaseHistory.resolve()
  const unsubscribe = await subscribe
  subscriber.emit("message", { channel: "updates", message: invalidEvent })
  subscriber.emit("message", { channel: "updates", message: liveEvent })
  unsubscribe()

  expect(received).toEqual([withCursor(historyEvent), withCursor(liveEvent)])
})

test("does not start the ping interval when unsubscribed during replay", async () => {
  const intervals = []
  const originalSetInterval = globalThis.setInterval
  globalThis.setInterval = (handler, timeout, ...args) => {
    const handle = originalSetInterval(handler, timeout, ...args)
    intervals.push(handle)
    return handle
  }

  try {
    const { subscriber, snapshotCaptured, releaseHistory, subscribe } = setup({
      historyEvents: [],
    })

    subscriber.emit("subscribe", 1)
    await snapshotCaptured.promise

    await subscriber.unsubscribe()

    releaseHistory.resolve()
    await subscribe

    expect(intervals).toHaveLength(0)
  } finally {
    globalThis.setInterval = originalSetInterval
    for (const handle of intervals) clearInterval(handle)
  }
})

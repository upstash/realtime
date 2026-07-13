import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"

import { Realtime } from "../src/server/index.js"

class FakeSubscriber extends EventEmitter {
  async unsubscribe() {
    this.emit("unsubscribe", 0)
  }
}

function setup({ historyEvents }) {
  const subscriber = new FakeSubscriber()
  const snapshotCaptured = Promise.withResolvers()
  const releaseHistory = Promise.withResolvers()
  const history = Object.fromEntries(
    historyEvents.map(({ id, ...fields }) => [id, fields])
  )
  const redis = {
    subscribe() {
      return subscriber
    },
    async xrange() {
      snapshotCaptured.resolve()
      await releaseHistory.promise
      return history
    },
    async publish() {
      return 1
    },
  }
  const received = []
  const realtime = new Realtime({ redis })
  const subscribe = realtime.channel("updates").subscribe({
    events: ["update"],
    history: true,
    onData(event) {
      received.push(event)
    },
  })

  return { subscriber, snapshotCaptured, releaseHistory, subscribe, received }
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

  expect(received).toEqual([historyEvent, liveEvent])
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

  expect(received).toEqual([event])
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

  expect(received).toEqual([historyEvent, freshEvent])
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

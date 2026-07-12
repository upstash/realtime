import { expect, test } from "bun:test"

import { Realtime } from "../dist/server/index.js"

class FakeSubscriber {
  listeners = new Map()

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }

  emit(event, payload) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload)
    }
  }

  async unsubscribe() {
    this.emit("unsubscribe", 0)
  }
}

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function historyEntry({ id: _id, ...event }) {
  return event
}

async function subscribeWithDelayedHistory({ historyEvents, liveEvent }) {
  const subscriber = new FakeSubscriber()
  const snapshotCaptured = deferred()
  const releaseHistory = deferred()
  const stream = new Map(historyEvents.map((event) => [event.id, historyEntry(event)]))
  const redis = {
    subscribe() {
      return subscriber
    },
    async xrange() {
      const snapshot = Object.fromEntries(stream)
      snapshotCaptured.resolve()
      await releaseHistory.promise
      return snapshot
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

  subscriber.emit("subscribe", 1)
  await snapshotCaptured.promise

  stream.set(liveEvent.id, historyEntry(liveEvent))
  subscriber.emit("message", { channel: "updates", message: liveEvent })

  releaseHistory.resolve()
  const unsubscribe = await subscribe

  return { received, unsubscribe }
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
  const { received, unsubscribe } = await subscribeWithDelayedHistory({
    historyEvents: [historyEvent],
    liveEvent,
  })

  try {
    expect(received).toEqual([historyEvent, liveEvent])
  } finally {
    await unsubscribe()
  }
})

test("deduplicates live events already included in history", async () => {
  const event = {
    id: "2-0",
    event: "update",
    channel: "updates",
    data: { value: "overlap" },
  }
  const { received, unsubscribe } = await subscribeWithDelayedHistory({
    historyEvents: [event],
    liveEvent: event,
  })

  try {
    expect(received).toEqual([event])
  } finally {
    await unsubscribe()
  }
})

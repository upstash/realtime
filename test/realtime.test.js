import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"

import { Realtime } from "../src/server/index.js"

class FakeSubscriber extends EventEmitter {
  async unsubscribe() {
    this.emit("unsubscribe", 0)
  }
}

async function subscribeWithDelayedHistory({ historyEvents, liveEvent }) {
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

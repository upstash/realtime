import { describe, expect, it, vi } from "vitest"

import { createSubscriptionRegistry } from "../src/client/subscription-registry.js"
import { getChannelsWithoutSubscribers } from "../src/client/subscription-utils.js"

describe("getChannelsWithoutSubscribers", () => {
  it("returns channels with no remaining subscribers", () => {
    const remaining = [{ channels: new Set(["room-1", "room-2"]) }]

    expect(getChannelsWithoutSubscribers(["room-1", "room-3"], remaining)).toEqual([
      "room-3",
    ])
  })

  it("returns all channels when none remain subscribed", () => {
    expect(getChannelsWithoutSubscribers(["room-1"], [])).toEqual(["room-1"])
  })
})

describe("createSubscriptionRegistry", () => {
  it("retains lastAck while another registration still uses the channel", () => {
    const registry = createSubscriptionRegistry()
    const callbackA = vi.fn()
    const callbackB = vi.fn()

    registry.register("a", ["room-1"], callbackA)
    registry.lastAck.set("room-1", "evt-1")

    registry.register("b", ["room-1"], callbackB)
    expect(registry.lastAck.get("room-1")).toBe("evt-1")

    registry.unregister("a")
    expect(registry.lastAck.get("room-1")).toBe("evt-1")
    expect(registry.subscriptions.size).toBe(1)

    registry.unregister("b")
    expect(registry.lastAck.has("room-1")).toBe(false)
    expect(registry.subscriptions.size).toBe(0)
  })

  it("clears lastAck only for channels with no remaining subscribers", () => {
    const registry = createSubscriptionRegistry()

    registry.register("a", ["room-1", "room-2"], vi.fn())
    registry.lastAck.set("room-1", "evt-1")
    registry.lastAck.set("room-2", "evt-2")

    registry.register("b", ["room-1"], vi.fn())
    registry.unregister("a")

    expect(registry.lastAck.get("room-1")).toBe("evt-1")
    expect(registry.lastAck.has("room-2")).toBe(false)
  })

  it("tracks the union of channels across registrations", () => {
    const registry = createSubscriptionRegistry()

    registry.register("a", ["room-1"], vi.fn())
    registry.register("b", ["room-2"], vi.fn())

    expect(Array.from(registry.getAllChannels()).sort()).toEqual(["room-1", "room-2"])

    registry.unregister("a")
    expect(Array.from(registry.getAllChannels())).toEqual(["room-2"])
  })
})

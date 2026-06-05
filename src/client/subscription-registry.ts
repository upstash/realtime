import type { RealtimeMessage } from "../shared/types.js"
import { getChannelsWithoutSubscribers } from "./subscription-utils.js"

export type SubscriptionEntry = {
  channels: Set<string>
  cb: (msg: RealtimeMessage) => void
}

export type SubscriptionRegistry = {
  subscriptions: Map<string, SubscriptionEntry>
  lastAck: Map<string, string>
  register: (id: string, channels: string[], cb: (msg: RealtimeMessage) => void) => void
  unregister: (id: string) => void
  getAllChannels: () => Set<string>
}

export function createSubscriptionRegistry(): SubscriptionRegistry {
  const subscriptions = new Map<string, SubscriptionEntry>()
  const lastAck = new Map<string, string>()

  const register = (id: string, channels: string[], cb: (msg: RealtimeMessage) => void) => {
    subscriptions.set(id, { channels: new Set(channels), cb })
  }

  const unregister = (id: string) => {
    const channels = Array.from(subscriptions.get(id)?.channels ?? [])
    subscriptions.delete(id)

    const channelsToClearAck = getChannelsWithoutSubscribers(
      channels,
      subscriptions.values()
    )

    for (const channel of channelsToClearAck) {
      lastAck.delete(channel)
    }
  }

  const getAllChannels = () => {
    const channels = new Set<string>()
    subscriptions.forEach((subscription) => {
      subscription.channels.forEach((channel) => channels.add(channel))
    })
    return channels
  }

  return {
    subscriptions,
    lastAck,
    register,
    unregister,
    getAllChannels,
  }
}

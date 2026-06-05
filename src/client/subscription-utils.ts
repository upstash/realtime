export type ChannelSubscription = {
  channels: Set<string>
}

export function getChannelsWithoutSubscribers(
  removedChannels: Iterable<string>,
  remainingSubscriptions: Iterable<ChannelSubscription>
): string[] {
  const activeChannels = new Set<string>()

  for (const subscription of remainingSubscriptions) {
    for (const channel of subscription.channels) {
      activeChannels.add(channel)
    }
  }

  return Array.from(removedChannels).filter((channel) => !activeChannels.has(channel))
}

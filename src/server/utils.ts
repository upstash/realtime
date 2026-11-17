export function compareStreamIds(a: string, b: string): number {
  const [aTime = 0n, aSequence = 0n] = a.split("-").map(BigInt)
  const [bTime = 0n, bSequence = 0n] = b.split("-").map(BigInt)

  if (aTime < bTime) return -1
  if (aTime > bTime) return 1
  if (aSequence < bSequence) return -1
  if (aSequence > bSequence) return 1
  return 0
}

/**
 * A string form of a stream id that sorts the way the ids do, so positions
 * can be compared with `<=` instead of being parsed on every comparison.
 */
export function streamOrder(id: string): string {
  const separator = id.indexOf("-")
  return id.slice(0, separator).padStart(20, "0") + id.slice(separator + 1).padStart(20, "0")
}

/**
 * Whether the Redis SDK can subscribe to a channel with this name.
 *
 * The SDK uses the name as one segment of the request path, so it has to come
 * through as exactly that segment. That rules out an empty name, "." and "..",
 * and names that contain "/", "\\", "?", "#", "%", tabs or line breaks, or end
 * with whitespace.
 */
export function isSubscribableChannel(channel: string): boolean {
  if (channel.length === 0) return false

  try {
    const url = new URL(`https://redis.invalid/subscribe/${channel}`)
    if (url.host !== "redis.invalid" || url.search !== "" || url.hash !== "") return false

    const segments = url.pathname.split("/")
    if (segments.length !== 3 || segments[1] !== "subscribe") return false

    return decodeURIComponent(segments[2] ?? "") === channel
  } catch {
    return false
  }
}

/**
 * Whether events on a channel can be delivered live.
 *
 * The SDK's subscription format separates its fields with commas, so it cannot
 * tell which channel a message belongs to when the name contains one.
 */
export function canDeliverLive(channel: string): boolean {
  return isSubscribableChannel(channel) && !channel.includes(",")
}

export class InvalidChannelError extends TypeError {
  constructor(channel: string) {
    super(
      `Cannot subscribe to channel ${JSON.stringify(channel)}. A channel name cannot be empty, "." or "..", end with whitespace, or contain "/", "\\", "?", "#", "%", tabs or line breaks.`
    )
    this.name = "InvalidChannelError"
  }
}

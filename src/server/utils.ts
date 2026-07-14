export function compareStreamIds(a: string, b: string): number {
  const [aTime = 0n, aSequence = 0n] = a.split("-").map(BigInt)
  const [bTime = 0n, bSequence = 0n] = b.split("-").map(BigInt)

  if (aTime < bTime) return -1
  if (aTime > bTime) return 1
  if (aSequence < bSequence) return -1
  if (aSequence > bSequence) return 1
  return 0
}

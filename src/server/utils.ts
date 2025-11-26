export function compareStreamIds(a: string, b: string): number {
    const [aTime = 0, aSeq = 0] = a.split("-").map(Number)
    const [bTime = 0, bSeq = 0] = b.split("-").map(Number)
  
    if (aTime !== bTime) return aTime - bTime
    return aSeq - bSeq
  }
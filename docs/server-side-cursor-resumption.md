# Server-side cursor resumption

Each event delivered by a server-side subscription includes an opaque, channel-specific
`cursor`. Pass the last successfully handled cursor as `after` to replay only later events before
continuing with live delivery:

```ts
import { CursorUnavailableError, isRealtimeCursor } from "@upstash/realtime"

const stored = await loadCursor("jobs")

if (stored !== null && isRealtimeCursor(stored)) {
  try {
    const unsubscribe = await realtime.channel("jobs").subscribe({
      events: ["job.updated"],
      after: stored,
      onData(message) {
        handleJobUpdate(message.data)
        saveCursor("jobs", message.cursor)
      },
    })
  } catch (error) {
    if (error instanceof CursorUnavailableError) {
      // Reload canonical state before starting a new subscription.
    }
  }
}
```

`after` is exclusive and cannot be combined with `history`. `RealtimeCursor` is a branded
string: `message.cursor` persists as a plain string, and a value read back from storage is
narrowed with `isRealtimeCursor` before it can be passed to `after`. Cursors must be reused
without modification on the channel that issued them. A cursor that has been trimmed, expired or
is otherwise unavailable rejects the initial subscription with `CursorUnavailableError`.

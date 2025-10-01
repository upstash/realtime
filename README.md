# Upstash Realtime

The easiest way to add realtime to any Next.js project.

- ◆ Deployable to Vercel
- ◆ 100% type-safe using zod v4
- ◆ Automatic connection management w/ delivery guarantee
- ◆ Powered by Upstash Redis streams

---

## Installation

```bash
bun install @upstash/realtime @upstash/redis zod
```

## Quickstart

### 1. Configure Redis

```ts
import { Redis } from "@upstash/redis"

export const redis = new Redis({
  // 👇 grab these from the Upstash Redis dashboard
  url: "https://striking-osprey-20681.upstash.io",
  token: "AVDJAAIjcDEyZ...",
})
```

### 2. Define your event schema

Define the structure of realtime events in your app.

```ts
import { Realtime } from "@upstash/realtime"
import { redis } from "./redis"
import z from "zod"

// 👇 possible events we can trigger and the data they need
const schema = z.object({
  notification: z.object({
    message: z.string(),
  }),
})

export const realtime = new Realtime({ schema, redis })
export type RealtimeEvents = z.infer<typeof schema>
```

### 3. Create SSE endpoint

Create your realtime endpoint under `/api/realtime/route.ts`. It's important that your route matches this path exactly.

```ts 
// app/api/realtime/route.ts
import { handle } from "@upstash/realtime"
import { realtime } from "@/lib"

export const GET = handle({ realtime })
```

### 4. Emit events

```ts
await realtime.notification.emit({
  message: "Hello world",
})
```

### 5. Subscribe to events

```tsx
"use client"

import { useRealtime } from "@upstash/realtime"
import { RealtimeEvents } from "@/lib"

export default function MyComponent() {
  useRealtime<RealtimeEvents>({
    events: {
      notification: (data) => {
        console.log(data.message)
      },
    },
  })

  return <div>Listening for events...</div>
}
```

---

## Usage

### Serverless Configuration

Serverless functions have execution time limits. The client automatically reconnects before timeout, with Redis Streams guaranteeing that no message is lost.

```ts
export const realtime = new Realtime({
  schema,
  redis,
  maxDurationSecs: 60, // Vercel Hobby: 60s, Pro: 500s
})
```

Match this to your API route timeout:

```ts
export const maxDuration = 60 // Vercel Hobby: 60s, Pro: 500s
export const GET = handle({ realtime })
```

**Vercel Note:** With fluid compute (default), you're only billed for active CPU time, not connection duration.

### Namespaces

Scope events to channels or rooms:

```ts
await realtime.namespace("room-123").notification.emit({
  message: "Hello",
})
```

```tsx
useRealtime<RealtimeEvents>({
  namespace: "room-123",
  events: {
    notification: (data) => console.log(data),
  },
})
```

### Connection Control

```tsx
const [enabled, setEnabled] = useState(true)

// status: "connecting" | "connected" | "disconnected" | "error"
const { status } = useRealtime<RealtimeEvents>({
  enabled,
  events: {
    notification: (data) => console.log(data),
  },
})
```

## License

MIT
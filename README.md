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

### 1. Configure Upstash Redis

```ts
// lib/redis.ts
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
// lib/realtime.ts
import { Realtime, InferRealtimeEvents } from "@upstash/realtime"
import { redis } from "./redis"
import z from "zod"

const schema = {
  notification: z.object({
    alert: z.string(),
  }),
}

export const realtime = new Realtime({ schema, redis })
export type RealtimeEvents = InferRealtimeEvents<typeof realtime>
```

### 3. Create realtime API endpoint

Create your realtime endpoint under `/api/realtime/route.ts`. It's important that your route matches this path exactly.

```ts
// api/realtime/route.ts
import { handle } from "@upstash/realtime"
import { realtime } from "@/lib"

export const GET = handle({ realtime })
```

### 4. Emit events

```ts
await realtime.notification.alert.emit("Hello world")
```

### 5. Subscribe to events

```tsx
"use client"

import { useRealtime } from "@upstash/realtime/client"
import type { RealtimeEvents } from "@/lib/realtime"

export default function MyComponent() {
  useRealtime<RealtimeEvents>({
    events: {
      notification: {
        // 👇 100% type-safe
        alert: (data) => console.log(data),
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

  // 👇 Set to - Vercel free plan: 60; Vercel pro plan: 500
  maxDurationSecs: 60,
})
```

Match this to your API route timeout:

```ts
// api/realtime/route.ts

// 👇 Set to - Vercel free plan: 60; Vercel pro plan: 500
export const maxDuration = 60

export const GET = handle({ realtime })
```

**Vercel Note:** With fluid compute (default), you're only billed for active CPU time, not connection duration. This makes Upstash Realtime very cost-efficient.

### Channels

Scope events to channels or rooms:

```ts
await realtime.channel("room-123").notification.alert.emit("Hello")
```

```tsx
import { useRealtime } from "@upstash/realtime/client"
import type { RealtimeEvents } from "@/lib/realtime"

useRealtime<RealtimeEvents>({
  channel: "room-123",
  events: {
    notification: {
      alert: (data) => console.log(data),
    },
  },
})
```

### Connection Control

```tsx
import { useState } from "react"
import { useRealtime } from "@upstash/realtime/client"
import type { RealtimeEvents } from "@/lib/realtime"

const [enabled, setEnabled] = useState(true)

const { status } = useRealtime<RealtimeEvents>({
  enabled,
  events: {
    notification: {
      alert: (data) => console.log(data),
    },
  },
})
```

---

## Advanced

### Middleware Authentication

Protect your realtime endpoints with custom authentication logic.

```ts
import { realtime } from "@/lib"
import { handle } from "@upstash/realtime"
import { currentUser } from "@/auth"

export const GET = handle({
  realtime,
  middleware: async ({ request, channel }) => {
    const user = await currentUser(request)

    if (channel === user.id) {
      return
    }

    if (channel !== user.id) {
      return new Response("Unauthorized", { status: 401 })
    }
  },
})
```

The middleware function receives:

- `request`: The incoming Request object
- `channel`: The channel the client is attempting to connect to

Return `undefined` or nothing to allow the connection. Return a `Response` object to block the connection with a custom error.

---

## License

MIT

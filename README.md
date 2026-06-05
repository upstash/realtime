# Upstash Realtime

The easiest way to add realtime features to any Next.js project.

![Project Image](https://github.com/upstash/realtime/blob/main/public/thumbnail.png)

## Features

- ⏰ Setup takes 60 seconds
- 🧨 Clean APIs & first-class TypeScript support
- ⚡ Extremely fast, zero dependencies, 1.9kB gzipped
- 💻 Deploy anywhere: Vercel, Netlify, etc.
- 💎 100% type-safe with zod 4 or zod mini
- ⏱️ Built-in message histories
- 🔌 Automatic connection management w/ delivery guarantee
- 🔋 Built-in middleware and authentication helpers
- 📶 100% HTTP-based: Redis streams & SSE

### Multiple hooks on the same channel

You can safely call `useRealtime()` multiple times with the same channel (for example, separate hooks that listen to different event subsets). The provider tracks per-channel ack state and only clears it when no active registration still uses that channel.

---

## Quickstart

Upstash Realtime quickstart, documentation & code examples 👇

[https://upstash.com/docs/realtime/overall/quickstart](https://upstash.com/docs/realtime/overall/quickstart)
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"
import {
  userEvent,
  systemEvent,
  type ConnectionStatus,
  type RealtimeMessage,
  EventPaths,
} from "../shared/types.js"
import { useRealtime, UseRealtimeOpts } from "./use-realtime.js"

type RealtimeContextValue = {
  status: ConnectionStatus
  register: (id: string, channels: string[], cb: (msg: RealtimeMessage) => void) => void
  unregister: (id: string) => void
}

export const RealtimeContext = createContext<RealtimeContextValue | null>(null)

const PING_TIMEOUT_MS = 75_000

// How many delivered event ids are remembered per channel to recognise a
// replay of something the hooks already received.
const MAX_REMEMBERED_IDS = 1000

const channelsKey = (channels: Iterable<string>) => JSON.stringify([...channels].sort())

export interface RealtimeProviderProps {
  children: React.ReactNode
  api?: { url?: string; withCredentials?: boolean }
  maxReconnectAttempts?: number
}

/**
 * @see node_modules/@upstash/realtime/docs/sdk/features/client-side.mdx
 */
export function RealtimeProvider({
  children,
  api = { url: "/api/realtime", withCredentials: false },
  maxReconnectAttempts = 3,
}: RealtimeProviderProps) {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected")

  const localSubsRef = useRef<
    Map<string, { channels: Set<string>; cb: (msg: RealtimeMessage) => void }>
  >(new Map())

  const eventSourceRef = useRef<EventSource | null>(null)
  const connectedChannelsRef = useRef<string | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const pingTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const lastAckRef = useRef<Map<string, string>>(new Map())
  const deliveredRef = useRef<Map<string, Set<string>>>(new Map())
  const lastReplaySinceRef = useRef<number | null>(null)
  const connectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const getAllNeededChannels = useCallback(() => {
    const channels = new Set<string>()
    localSubsRef.current.forEach((sub) => {
      sub.channels.forEach((ch) => channels.add(ch))
    })
    return channels
  }, [])

  const cleanup = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    connectedChannelsRef.current = null
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
    if (pingTimeoutRef.current) {
      clearTimeout(pingTimeoutRef.current)
      pingTimeoutRef.current = null
    }
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current)
      connectTimeoutRef.current = null
    }

    reconnectAttemptsRef.current = 0

    setStatus("disconnected")
  }

  const resetPingTimeout = useCallback(() => {
    if (pingTimeoutRef.current) {
      clearTimeout(pingTimeoutRef.current)
    }

    pingTimeoutRef.current = setTimeout(() => {
      console.warn("Connection timed out, reconnecting...")
      connect()
    }, PING_TIMEOUT_MS)
  }, [])

  type ConnectOpts = {
    replayEventsSince?: number
  }

  const connect = (opts?: ConnectOpts) => {
    const { replayEventsSince } = opts ?? {
      replayEventsSince: lastReplaySinceRef.current ?? Date.now(),
    }
    lastReplaySinceRef.current = replayEventsSince ?? null
    const channels = Array.from(getAllNeededChannels())

    if (channels.length === 0) return

    if (reconnectAttemptsRef.current >= maxReconnectAttempts) {
      console.log("Max reconnection attempts reached.")
      setStatus("error")
      return
    }

    cleanup()

    setStatus("connecting")

    try {
      const channelsParam = channels
        .map((ch) => `channel=${encodeURIComponent(ch)}`)
        .join("&")

      const lastAckParam = channels
        .map((c) => {
          const lastAck = lastAckRef.current.get(c) ?? String(replayEventsSince)
          return `last_ack_${encodeURIComponent(c)}=${encodeURIComponent(lastAck)}`
        })
        .join("&")

      const url = api.url + "?" + channelsParam + "&" + lastAckParam

      const eventSource = new EventSource(url, {
        withCredentials: api.withCredentials ?? false,
      })
      eventSourceRef.current = eventSource
      connectedChannelsRef.current = channelsKey(channels)

      eventSource.onopen = () => {
        reconnectAttemptsRef.current = 0
        setStatus("connected")
        resetPingTimeout()
      }

      eventSource.onmessage = (evt) => {
        try {
          const payload: RealtimeMessage = JSON.parse(evt.data)
          resetPingTimeout()

          handleMessage(payload)

          const systemResult = systemEvent.safeParse(payload)

          if (systemResult.success) {
            if (systemResult.data.type === "reconnect") {
              connect({ replayEventsSince: systemResult.data.timestamp })
            }
          }
        } catch (error) {
          console.warn("Error parsing message:", error)
        }
      }

      eventSource.onerror = () => {
        if (eventSource !== eventSourceRef.current) return

        const readyState = eventSourceRef.current?.readyState
        if (readyState === EventSource.CONNECTING) return

        if (readyState === EventSource.CLOSED) {
          console.log("Connection closed, reconnecting...")
        }

        setStatus("disconnected")

        if (reconnectAttemptsRef.current < maxReconnectAttempts) {
          reconnectAttemptsRef.current++
          reconnectTimeoutRef.current = setTimeout(() => {
            connect()
          }, Math.min(1000 * reconnectAttemptsRef.current, 10000))
        } else {
          setStatus("error")
        }
      }
    } catch (error) {
      setStatus("error")
    }
  }

  const debouncedConnect = useCallback(() => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current)
    }

    debounceTimeoutRef.current = setTimeout(() => {
      debounceTimeoutRef.current = null

      // A hook mounting or unmounting only needs a new connection when it
      // changes which channels are needed.
      const eventSource = eventSourceRef.current
      const isCurrent =
        eventSource !== null &&
        eventSource.readyState !== EventSource.CLOSED &&
        connectedChannelsRef.current === channelsKey(getAllNeededChannels())

      if (!isCurrent) connect()
    }, 25)
  }, [connect])

  const handleMessage = (payload: RealtimeMessage) => {
    const systemResult = systemEvent.safeParse(payload)

    if (systemResult.success) {
      const event = systemResult.data
      if (event.type === "connected") {
        if (event.cursor) {
          lastAckRef.current.set(event.channel, event.cursor)
        }
      }

      return
    }

    const event = userEvent.safeParse(payload)

    if (event.success) {
      const { channel, id } = event.data

      // A connection lives longer now that hooks mounting and unmounting no
      // longer replace it. When the browser re-opens it by itself it reuses
      // the original URL, and the server replays from that older position.
      // Events the hooks already received are dropped here.
      let delivered = deliveredRef.current.get(channel)
      if (!delivered) {
        delivered = new Set()
        deliveredRef.current.set(channel, delivered)
      }
      if (delivered.has(id)) return

      delivered.add(id)
      if (delivered.size > MAX_REMEMBERED_IDS) {
        const oldest = delivered.values().next().value
        if (oldest !== undefined) delivered.delete(oldest)
      }

      lastAckRef.current.set(channel, id)

      localSubsRef.current.forEach((sub) => {
        if (sub.channels.has(event.data.channel)) {
          sub.cb(payload)
        }
      })
    }
  }

  useEffect(() => {
    return () => cleanup()
  }, [])

  const register = (
    id: string,
    channels: string[],
    cb: (msg: RealtimeMessage) => void
  ) => {
    localSubsRef.current.set(id, { channels: new Set(channels), cb })
    debouncedConnect()
  }

  const unregister = (id: string) => {
    const channels = Array.from(localSubsRef.current.get(id)?.channels ?? [])

    localSubsRef.current.delete(id)

    // Another hook may still be listening on the channel. Its position has to
    // survive, or the next reconnect would replay events it already received.
    const neededChannels = getAllNeededChannels()

    channels.forEach((channel) => {
      if (neededChannels.has(channel)) return

      lastAckRef.current.delete(channel)
      deliveredRef.current.delete(channel)
    })

    if (localSubsRef.current.size === 0) {
      cleanup()

      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current)
        debounceTimeoutRef.current = null
      }

      return
    }

    debouncedConnect()
  }

  return (
    <RealtimeContext.Provider value={{ status, register, unregister }}>
      {children}
    </RealtimeContext.Provider>
  )
}

export function useRealtimeContext() {
  const context = useContext(RealtimeContext)
  if (!context) {
    throw new Error("useRealtimeContext must be used within a RealtimeProvider")
  }
  return context
}

/**
 * @see node_modules/@upstash/realtime/docs/sdk/features/client-side.mdx
 */
export const createRealtime = <T extends Record<string, any>>() => ({
  useRealtime: <const E extends EventPaths<T>>(opts: UseRealtimeOpts<T, E>) =>
    useRealtime(opts),
})

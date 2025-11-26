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
} from "../shared/types"
import { useRealtime, UseRealtimeOpts } from "./use-realtime"

type RealtimeContextValue = {
  status: ConnectionStatus
  register: (id: string, channels: string[], cb: (msg: RealtimeMessage) => void) => void
  unregister: (id: string) => void
}

export const RealtimeContext = createContext<RealtimeContextValue | null>(null)

const PING_TIMEOUT_MS = 75_000

export interface RealtimeProviderProps {
  children: React.ReactNode
  api?: { url?: string; withCredentials?: boolean }
  maxReconnectAttempts?: number
}

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
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const pingTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const lastAckRef = useRef<Map<string, string>>(new Map())
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
    const { replayEventsSince } = opts ?? { replayEventsSince: Date.now() }
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
      connect()
      debounceTimeoutRef.current = null
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
      lastAckRef.current.set(event.data.channel, event.data.id)

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

    channels.forEach((channel) => {
      lastAckRef.current.delete(channel)
    })

    localSubsRef.current.delete(id)

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

export const createRealtime = <T extends Record<string, any>>() => ({
  useRealtime: <const E extends EventPaths<T>>(opts: UseRealtimeOpts<T, E>) =>
    useRealtime(opts),
})

import { useEffect, useRef, useState } from "react"
import type {
  ConnectionStatus,
  RealtimeMessage,
  SystemEvent,
  UserEvent,
} from "../types.js"

interface Opts<T> {
  channel?: string
  enabled?: boolean
  history?: { length?: number; since?: number } | boolean
  events?: Partial<{
    [N in keyof T]: Partial<{
      [K in keyof T[N]]: (data: T[N][K]) => void
    }>
  }>
  maxReconnectAttempts?: number
}

const PING_TIMEOUT_MS = 20_000

export const useRealtime = <T extends Record<string, Record<string, unknown>>>({
  channel = "default",
  enabled = true,
  history,
  events,
  maxReconnectAttempts = 3,
}: Opts<T> = {}) => {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected")

  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const pingTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const reconnectAttemptsRef = useRef(0)

  const connectedChannelsRef = useRef<Set<string>>(new Set())
  const lastAckRef = useRef<Map<string, string>>(new Map())

  const cleanup = (preserveReconnectCount = false) => {
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
    if (!preserveReconnectCount) {
      reconnectAttemptsRef.current = 0
    }

    setStatus("disconnected")
  }

  const resetPingTimeout = () => {
    if (pingTimeoutRef.current) {
      clearTimeout(pingTimeoutRef.current)
    }

    pingTimeoutRef.current = setTimeout(() => {
      console.warn("Realtime connection timed out, reconnecting...")
      connect({ reconnect: true })
    }, PING_TIMEOUT_MS)
  }

  const connect = ({ reconnect = false }: { reconnect?: boolean } = {}) => {
    if (reconnectAttemptsRef.current >= maxReconnectAttempts) {
      console.log("Max reconnection attempts reached.")
      setStatus("error")
      return
    }

    cleanup(reconnect)

    setStatus("connecting")

    try {
      const connectionStartTime = Date.now()
      const reconnectParam = reconnect ? "&reconnect=true" : ""

      const historyParams: string[] = []
      if (history === true) {
        historyParams.push("history_all=true")
      } else if (typeof history === "object") {
        if (history.length !== undefined) {
          historyParams.push(`history_length=${history.length}`)
        }
        if (history.since !== undefined) {
          historyParams.push(`history_since=${history.since}`)
        }
      }

      const historyParamsString =
        !reconnect && historyParams.length > 0 ? `&${historyParams.join("&")}` : ""

      const lastAck = lastAckRef.current.get(channel)

      const lastAckParam =
        reconnect && lastAck ? `&last_ack=${encodeURIComponent(lastAck)}` : ""

      const connectionStartParam = !reconnect
        ? `&connection_start=${connectionStartTime}`
        : ""

      const eventSource = new EventSource(
        `/api/realtime?channel=${encodeURIComponent(
          channel
        )}${reconnectParam}${lastAckParam}${historyParamsString}${connectionStartParam}`
      )
      eventSourceRef.current = eventSource

      eventSource.onopen = () => {
        reconnectAttemptsRef.current = 0
        setStatus("connected")
        resetPingTimeout()
        connectedChannelsRef.current.add(channel)
      }

      eventSource.onmessage = (evt) => {
        try {
          const payload: RealtimeMessage = JSON.parse(evt.data)

          resetPingTimeout()

          if ("type" in payload) {
            const systemEvent = payload as SystemEvent

            switch (systemEvent.type) {
              case "connected":
                const lastAckValue = lastAckRef.current.get(channel)

                if (systemEvent.cursor && !lastAckValue) {
                  lastAckRef.current.set(channel, systemEvent.cursor)
                }
                break
              case "reconnect":
                connect({ reconnect: true })
                break
              case "ping":
                break
              case "error":
                console.error("Server error:", systemEvent.error)
                break
              case "disconnected":
                break
            }
            return
          }

          if ("__event_path" in payload && "__stream_id" in payload) {
            const userEvent = payload as UserEvent

            lastAckRef.current.set(channel, userEvent.__stream_id)

            const handler = userEvent.__event_path.reduce(
              (acc: any, key: any) => acc?.[key],
              events
            )

            handler?.(userEvent.data)
          }
        } catch (error) {
          console.warn("Error parsing message:", error)
        }
      }

      eventSource.onerror = () => {
        const readyState = eventSourceRef.current?.readyState

        if (readyState === EventSource.CONNECTING) {
          return
        }

        if (readyState === EventSource.CLOSED) {
          console.log("Connection closed, reconnecting...")
        }

        setStatus("disconnected")

        if (reconnectAttemptsRef.current < maxReconnectAttempts) {
          reconnectAttemptsRef.current++
          console.log(
            `Reconnecting (${reconnectAttemptsRef.current}/${maxReconnectAttempts})...`
          )

          reconnectTimeoutRef.current = setTimeout(() => {
            connect({ reconnect: true })
          }, Math.min(1000 * reconnectAttemptsRef.current, 10000))
        } else {
          setStatus("error")
        }
      }
    } catch (error) {
      setStatus("error")
    }
  }

  useEffect(() => {
    if (enabled === false) {
      return cleanup()
    }

    if (eventSourceRef.current?.readyState === EventSource.CONNECTING) {
      return
    }

    if (connectedChannelsRef.current.has(channel)) {
      connect({ reconnect: true })
      return
    }

    connect()

    return () => cleanup()
  }, [channel, enabled, JSON.stringify(history), maxReconnectAttempts])

  return { status }
}

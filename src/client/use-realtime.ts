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
  events?: Partial<{
    [N in keyof T]: Partial<{
      [K in keyof T[N]]: (data: T[N][K]) => void
    }>
  }>
  maxReconnectAttempts?: number
}

export const useRealtime = <T extends Record<string, Record<string, unknown>>>({
  channel = "default",
  enabled = true,
  events,
  maxReconnectAttempts = 3,
}: Opts<T> = {}) => {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected")

  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const lastAckRef = useRef<string | null>(null)
  const isInitialConnectionRef = useRef<boolean>(true)
  const processedIdsRef = useRef<Set<string>>(new Set())

  const cleanup = (preserveReconnectCount = false) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
    if (!preserveReconnectCount) {
      reconnectAttemptsRef.current = 0
    }

    setStatus("disconnected")
  }

  const connect = ({
    reconnect = !Boolean(isInitialConnectionRef.current) || false,
  }: { reconnect?: boolean } = {}) => {
    if (reconnectAttemptsRef.current >= maxReconnectAttempts) {
      console.log("Max reconnection attempts reached.")
      setStatus("error")
      return
    }

    cleanup(reconnect)

    setStatus("connecting")

    try {
      const reconnectParam = reconnect ? "&reconnect=true" : ""

      const lastAckParam =
        reconnect && lastAckRef.current
          ? `&last_ack=${encodeURIComponent(lastAckRef.current)}`
          : ""

      const eventSource = new EventSource(
        `/api/realtime?channel=${encodeURIComponent(
          channel
        )}${reconnectParam}${lastAckParam}`
      )
      eventSourceRef.current = eventSource

      eventSource.onopen = () => {
        reconnectAttemptsRef.current = 0
        setStatus("connected")
        isInitialConnectionRef.current = false
      }

      eventSource.onmessage = (evt) => {
        try {
          const payload: RealtimeMessage = JSON.parse(evt.data)

          if ("type" in payload) {
            const systemEvent = payload as SystemEvent

            switch (systemEvent.type) {
              case "connected":
                if (systemEvent.cursor && !lastAckRef.current) {
                  lastAckRef.current = systemEvent.cursor
                }
                break
              case "reconnect":
                connect({ reconnect: true })
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

            if (processedIdsRef.current.has(userEvent.__stream_id)) {
              // skip
              return
            }

            processedIdsRef.current.add(userEvent.__stream_id)
            lastAckRef.current = userEvent.__stream_id

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

    connect()

    return cleanup
  }, [channel, enabled])

  return { status }
}

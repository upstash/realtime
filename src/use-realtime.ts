import { useEffect, useRef, useState } from "react"

interface Opts<T> {
  namespace?: string
  enabled?: boolean
  events?: Partial<{
    [K in keyof T]: (data: T[K]) => void
  }>
  maxReconnectAttempts?: number
}

export const useRealtime = <T extends Record<string, unknown>>({
  namespace = "default",
  enabled = true,
  events,
  maxReconnectAttempts = 3,
}: Opts<T> = {}) => {
  const [status, setStatus] = useState<
    "connected" | "disconnected" | "error" | "connecting"
  >("disconnected")

  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const lastAckRef = useRef<string | null>(null)
  const isInitialConnectionRef = useRef<boolean>(true)
  const processedIdsRef = useRef<Set<string>>(new Set())

  const cleanup = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
    reconnectAttemptsRef.current = 0

    setStatus("disconnected")
  }

  const connect = ({
    reconnect = !Boolean(isInitialConnectionRef.current) || false,
  }: { reconnect?: boolean } = {}) => {
    if (reconnectAttemptsRef.current >= maxReconnectAttempts) {
      console.error("Max reconnection attempts reached, stopping retries")
      setStatus("error")
      return
    }

    cleanup()

    setStatus("connecting")

    try {
      const reconnectParam = reconnect ? "&reconnect=true" : ""

      const lastAckParam =
        reconnect && lastAckRef.current
          ? `&last_ack=${encodeURIComponent(lastAckRef.current)}`
          : ""

      const eventSource = new EventSource(
        `/api/realtime?namespace=${encodeURIComponent(
          namespace
        )}${reconnectParam}${lastAckParam}`
      )
      eventSourceRef.current = eventSource

      eventSource.onopen = () => {
        console.log("EventSource connection opened")
        reconnectAttemptsRef.current = 0
        setStatus("connected")
        isInitialConnectionRef.current = false
      }

      eventSource.onmessage = (evt) => {
        try {
          const payload = JSON.parse(evt.data)

          if (payload.type === "connected") {
            console.log(`Connected to namespace: ${payload.namespace}`)
            if (payload.cursor && !lastAckRef.current) {
              lastAckRef.current = payload.cursor
            }
            return
          }

          if (payload.type === "reconnect") {
            console.log("Server requested reconnect, initiating...")
            connect({ reconnect: true })
            return
          }

          if (payload.type === "error") {
            console.error("Server error:", payload.error)
            return
          }

          if (payload.id) {
            if (processedIdsRef.current.has(payload.id)) {
              console.log("Skipping duplicate message:", payload.id)
              return
            }
            processedIdsRef.current.add(payload.id)
            lastAckRef.current = payload.id
          }

          const event = payload.event as keyof T

          if (events?.[event]) {
            events[event]({ ...payload, event: undefined })
          }
        } catch (error) {
          console.error("Error parsing message:", error)
        }
      }

      eventSource.onerror = (error) => {
        console.error("EventSource error:", error)

        if (
          eventSourceRef.current?.readyState === EventSource.CLOSED ||
          eventSourceRef.current?.readyState === EventSource.CONNECTING
        ) {
          return
        }

        setStatus("disconnected")

        if (reconnectAttemptsRef.current < maxReconnectAttempts) {
          reconnectAttemptsRef.current++
          console.log(
            `Attempting reconnect ${reconnectAttemptsRef.current}/${maxReconnectAttempts}`
          )

          reconnectTimeoutRef.current = setTimeout(() => {
            if (reconnectAttemptsRef.current < maxReconnectAttempts) {
              connect({ reconnect: true })
            }
          }, Math.min(1000 * reconnectAttemptsRef.current, 10000))
        } else {
          console.error("Max reconnection attempts reached")
          setStatus("error")
        }
      }
    } catch (error) {
      console.error("Connection error:", error)
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

    console.log(eventSourceRef.current?.readyState)
    connect()

    return cleanup
  }, [namespace, enabled])

  return { status }
}

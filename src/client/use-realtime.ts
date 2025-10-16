import { useEffect, useRef, useState } from "react"
import type {
  ConnectionStatus,
  RealtimeMessage,
  SystemEvent,
  UserEvent,
} from "../types.js"

type IsEventMap<T> = T extends Record<string, any>
  ? keyof T extends string
    ? {
        [K in keyof T]: T[K] extends Record<string, any> ? true : false
      }[keyof T] extends true
      ? true
      : false
    : false
  : false

type InferredEventPaths<T, Prefix extends string = "", Depth extends number = 0> = {
  [K in keyof T]: K extends string
    ? T[K] extends Record<string, any>
      ? Depth extends 0
        ? IsEventMap<T[K]> extends true
          ? InferredEventPaths<T[K], `${K}.`, 1>
          : never
        : Depth extends 1
        ? `${Prefix}${K}`
        : never
      : Prefix extends ""
      ? K
      : `${Prefix}${K}`
    : never
}[keyof T]

type GetEventData<T, Path> = Path extends `${infer First}.${infer Rest}`
  ? First extends keyof T
    ? GetEventData<T[First], Rest>
    : never
  : Path extends keyof T
  ? T[Path]
  : unknown

interface UseRealtimeOpts<T extends Record<string, any>, K extends string> {
  channels?: string[]
  enabled?: boolean
  history?: { length?: number; since?: number } | boolean
  event: K
  onData: (data: GetEventData<T, K>, channel: string) => void
  maxReconnectAttempts?: number
}

const PING_TIMEOUT_MS = 20_000

export const useRealtime = <
  T extends Record<string, any>,
  K extends InferredEventPaths<T> = InferredEventPaths<T>
>({
  channels = ["default"],
  enabled = true,
  history,
  event,
  onData,
  maxReconnectAttempts = 3,
}: UseRealtimeOpts<T, K>) => {
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

      const lastAckParams = channels
        .map((ch) => {
          const lastAck = lastAckRef.current.get(ch)
          return reconnect && lastAck ? `last_ack_${encodeURIComponent(ch)}=${encodeURIComponent(lastAck)}` : null
        })
        .filter(Boolean)
        .join("&")

      const lastAckParamsString = lastAckParams ? `&${lastAckParams}` : ""

      const connectionStartParam = !reconnect
        ? `&connection_start=${connectionStartTime}`
        : ""

      const channelsParam = channels.map((ch) => `channels=${encodeURIComponent(ch)}`).join("&")

      const eventSource = new EventSource(
        `/api/realtime?${channelsParam}${reconnectParam}${lastAckParamsString}${historyParamsString}${connectionStartParam}`
      )
      eventSourceRef.current = eventSource

      eventSource.onopen = () => {
        reconnectAttemptsRef.current = 0
        setStatus("connected")
        resetPingTimeout()
        channels.forEach((ch) => connectedChannelsRef.current.add(ch))
      }

      eventSource.onmessage = (evt) => {
        try {
          const payload: RealtimeMessage = JSON.parse(evt.data)

          resetPingTimeout()

          if ("type" in payload) {
            const systemEvent = payload as SystemEvent

            switch (systemEvent.type) {
              case "connected":
                const channelName = systemEvent.channel
                const lastAckValue = lastAckRef.current.get(channelName)

                if (systemEvent.cursor && !lastAckValue) {
                  lastAckRef.current.set(channelName, systemEvent.cursor)
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

            if (userEvent.__channel) {
              lastAckRef.current.set(userEvent.__channel, userEvent.__stream_id)
            }

            const eventPath = userEvent.__event_path.join(".")
            const channel = userEvent.__channel || "default"

            if (eventPath === event) {
              onData(userEvent.data as GetEventData<T, K>, channel)
            }
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

    const channelsChanged = channels.some(
      (ch) => !connectedChannelsRef.current.has(ch)
    ) || connectedChannelsRef.current.size !== channels.length

    if (!channelsChanged && connectedChannelsRef.current.size > 0) {
      return
    }

    connect()

    return () => cleanup()
  }, [JSON.stringify(channels), enabled, JSON.stringify(history), maxReconnectAttempts])

  return { status }
}

import { useEffect, useRef, useState } from "react"
import type {
  ConnectionStatus,
  RealtimeMessage,
  SystemEvent,
  UserEvent,
} from "../types.js"
import * as z from "zod/v4/core"

const PING_TIMEOUT_MS = 20_000

type EventPaths<
  T,
  Prefix extends string = "",
  Depth extends readonly number[] = []
> = Depth["length"] extends 10
  ? never
  : {
      [K in keyof T & string]: T[K] extends z.$ZodType
        ? `${Prefix}${K}`
        : T[K] extends Record<string, any>
        ? EventPaths<T[K], `${Prefix}${K}.`, [...Depth, 0]>
        : `${Prefix}${K}`
    }[keyof T & string]

type EventData<
  T,
  K extends string,
  Depth extends readonly number[] = []
> = Depth["length"] extends 10
  ? never
  : K extends `${infer A}.${infer Rest}`
  ? A extends keyof T
    ? T[A] extends z.$ZodType
      ? never
      : EventData<T[A], Rest, [...Depth, 0]>
    : never
  : K extends keyof T
  ? T[K] extends z.$ZodType
    ? T[K]
    : never
  : never

interface UseRealtimeOpts<T extends Record<string, any>, K extends EventPaths<T>> {
  event?: K
  onData?: (data: z.infer<EventData<T, K>>, channel: string) => void
  channels?: (string | undefined)[]
  enabled?: boolean
  history?: { length?: number; since?: number } | boolean
  maxReconnectAttempts?: number
  api?: { url?: string; withCredentials?: boolean }
}

export function useRealtime<T extends Record<string, any>>(
  opts?: { [K in EventPaths<T>]: UseRealtimeOpts<T, K> }[EventPaths<T>]
): { status: ConnectionStatus }
export function useRealtime<T extends Record<string, any>, const K extends EventPaths<T>>(
  opts?: UseRealtimeOpts<T, K>
): { status: ConnectionStatus }

// impl
export function useRealtime<T extends Record<string, any>, const K extends EventPaths<T>>(
  opts: UseRealtimeOpts<T, K> = {} as UseRealtimeOpts<T, K>
) {
  const {
    channels = ["default"],
    maxReconnectAttempts = 3,
    api = { url: "/api/realtime", withCredentials: false },
    event,
    onData,
    enabled,
    history,
  } = opts

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

    if (channels.filter(Boolean).length === 0) {
      return
    }

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
        .filter(Boolean)
        .map((ch) => {
          const lastAck = lastAckRef.current.get(ch as string)
          return reconnect && lastAck
            ? `last_ack_${encodeURIComponent(ch as string)}=${encodeURIComponent(
                lastAck
              )}`
            : null
        })
        .filter(Boolean)
        .join("&")

      const lastAckParamsString = lastAckParams ? `&${lastAckParams}` : ""

      const connectionStartParam = !reconnect
        ? `&connection_start=${connectionStartTime}`
        : ""

      const channelsParam = channels
        .filter(Boolean)
        .map((ch) => `channels=${encodeURIComponent(ch as string)}`)
        .join("&")

      const eventSource = new EventSource(
        api.url +
          `?${channelsParam}${reconnectParam}${lastAckParamsString}${historyParamsString}${connectionStartParam}`,
        { withCredentials: api.withCredentials ?? false }
      )

      eventSourceRef.current = eventSource

      eventSource.onopen = () => {
        reconnectAttemptsRef.current = 0
        setStatus("connected")
        resetPingTimeout()
        channels
          .filter(Boolean)
          .forEach((ch) => connectedChannelsRef.current.add(ch as string))
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
              onData?.(userEvent.data as any, channel)
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

    const channelsChanged =
      channels
        .filter(Boolean)
        .some((ch) => !connectedChannelsRef.current.has(ch as string)) ||
      connectedChannelsRef.current.size !== channels.length

    if (!channelsChanged && connectedChannelsRef.current.size > 0) {
      return
    }

    connect()

    return () => cleanup()
  }, [JSON.stringify(channels), enabled, JSON.stringify(history), maxReconnectAttempts])

  return { status }
}

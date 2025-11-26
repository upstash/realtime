import { useContext, useEffect, useRef } from "react"
import {
  EventPaths,
  EventPayloadUnion,
  userEvent
} from "../shared/types.js"
import { RealtimeContext } from "./provider.js"

export interface UseRealtimeOpts<T extends Record<string, any>, E extends string> {
  events?: readonly E[]
  onData?: (arg: EventPayloadUnion<T, E>) => void
  channels?: readonly (string | undefined)[]
  enabled?: boolean
}

export function useRealtime<T extends Record<string, any>, const E extends EventPaths<T>>(
  opts: UseRealtimeOpts<T, E>
) {
  const { channels = ["default"], events, onData, enabled } = opts

  const context = useContext(RealtimeContext)

  if (!context) {
    throw new Error(
      "useRealtime: No RealtimeProvider found. Wrap your app in <RealtimeProvider> to use Upstash Realtime."
    )
  }

  const registrationId = useRef(Math.random().toString(36).substring(2)).current
  const onDataRef = useRef(onData)
  onDataRef.current = onData

  useEffect(() => {
    if (enabled === false) {
      context.unregister(registrationId)
      return
    }

    const validChannels = channels.filter(Boolean) as string[]
    if (validChannels.length === 0) return

    context.register(registrationId, validChannels, (msg) => {
      const result = userEvent.safeParse(msg)

      if (result.success) {
        const { event, channel, data } = result.data

        if (events && events.length > 0 && !events.includes(event as E)) {
          return
        }

        const payload: EventPayloadUnion<any, any> = { event, data, channel }

        // @ts-expect-error EventPayloadUnion generic mismatch
        onDataRef.current?.(payload)
      }
    })

    return () => {
      context.unregister(registrationId)
    }
  }, [JSON.stringify(channels), enabled, JSON.stringify(events)])

  return { status: context.status }
}

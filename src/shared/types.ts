import z from "zod/v4"
import core from "zod/v4/core"

export const systemEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("connected"),
    channel: z.string(),
    cursor: z.string().optional(),
  }),
  z.object({ type: z.literal("reconnect"), timestamp: z.number() }),
  z.object({ type: z.literal("error"), error: z.string() }),
  z.object({ type: z.literal("disconnected"), channels: z.array(z.string()) }),
  z.object({ type: z.literal("ping"), timestamp: z.number() }),
])

export type SystemEvent = z.infer<typeof systemEvent>

export const userEvent = z.object({
  id: z.string(),
  data: z.unknown(),
  event: z.string(),
  channel: z.string(),
})

export type UserEvent = z.infer<typeof userEvent>

export type RealtimeMessage = SystemEvent | UserEvent

export type ConnectionStatus = "connected" | "disconnected" | "error" | "connecting"

export type EventPaths<
  T,
  Prefix extends string = "",
  Depth extends readonly number[] = []
> = Depth["length"] extends 10
  ? never
  : {
      [K in keyof T & string]: T[K] extends core.$ZodType
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
    ? T[A] extends core.$ZodType
      ? never
      : EventData<T[A], Rest, [...Depth, 0]>
    : never
  : K extends keyof T
  ? T[K] extends core.$ZodType
    ? T[K]
    : never
  : never

export type EventPayloadUnion<T, E extends string> = E extends any
  ? { event: E; data: core.infer<EventData<T, E>>; channel: string }
  : never

export type HistoryArgs = { limit?: number; start?: number; end?: number }

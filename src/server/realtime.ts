import { type Redis } from "@upstash/redis"
import * as z from "zod/v4/core"
import {
  EventPaths,
  EventPayloadUnion,
  HistoryArgs,
  userEvent,
  type UserEvent
} from "../shared/types.js"
import { compareStreamIds } from "./utils.js"

const DEFAULT_VERCEL_FLUID_TIMEOUT = 300

type Schema = Record<string, z.$ZodType | Record<string, any>>

export type Opts = {
  schema?: Schema
  redis?: Redis | undefined
  maxDurationSecs?: number
  verbose?: boolean
  history?:
    | {
        maxLength?: number
        expireAfterSecs?: number
      }
    | boolean
}

class RealtimeBase<T extends Opts> {
  private channels: Record<string, any> = {}
  private _schema: Schema
  private _verbose: boolean
  private _history: {
    maxLength?: number
    expireAfterSecs?: number
  }
  private _trimConfig?: NonNullable<Parameters<Redis["xadd"]>[3]>["trim"]

  /** @internal */
  public readonly _redis?: Redis | undefined

  /** @internal */
  public readonly _maxDurationSecs: number

  /** @internal */
  public readonly _logger = {
    log: (...args: any[]) => {
      if (this._verbose) console.log(...args)
    },
    warn: (...args: any[]) => {
      if (this._verbose) console.warn(...args)
    },
    error: (...args: any[]) => {
      if (this._verbose) console.error(...args)
    },
  }

  constructor(data: T) {
    Object.assign(this, data)
    this._schema = data.schema || {}
    this._redis = data.redis
    this._maxDurationSecs = data.maxDurationSecs ?? DEFAULT_VERCEL_FLUID_TIMEOUT
    this._verbose = data.verbose ?? false
    this._history = typeof data.history === "boolean" ? {} : data.history ?? {}

    this._trimConfig = this._history.maxLength
      ? {
          type: "MAXLEN",
          threshold: this._history.maxLength,
          comparison: "=",
        }
      : undefined

    Object.assign(this, this.createEventHandlers("default"))
  }

  private createEventHandlers(channel: string): any {
    const handlers: any = {}
    let unsubscribe: undefined | (() => void) = undefined
    let pingInterval: undefined | NodeJS.Timeout = undefined

    const startPingInterval = () => {
      pingInterval = setInterval(() => {
        this._redis?.publish(channel, { type: "ping", timestamp: Date.now() })
      }, 60_000)
    }

    const stopPingInterval = () => {
      if (pingInterval) clearInterval(pingInterval)
    }

    handlers.history = async (args?: HistoryArgs) => {
      const redis = this._redis
      if (!redis) throw new Error("Redis not configured.")

      const start = args?.start ? String(args.start) : "-"
      const end = args?.end ? String(args.end) : "+"
      const limit = Math.min(args?.limit ?? 1000, 1000)

      const history = (await redis.xrange(channel, start, end, limit)) as Record<
        string,
        UserEvent
      >

      const messages = Object.entries(history)

      return messages
        .map(([_, value]) => {
          if (typeof value === "object" && value !== null) {
            const { id, channel, event, data } = value
            return { data, event, id, channel }
          }
          return null
        })
        .filter(Boolean)
    }

    handlers.unsubscribe = () => {
      if (unsubscribe) {
        unsubscribe()
        this._logger.log("✅ Connection closed successfully.")
      }
    }

    handlers.subscribe = async ({
      events,
      onData,
      history,
    }: SubscribeArgs<any, any>): Promise<() => void> => {
      const redis = this._redis
      if (!redis) throw new Error("Redis not configured.")

      const buffer: UserEvent[] = []
      let isHistoryReplayed = false
      let lastHistoryId: string | null = null

      const sub = redis.subscribe<UserEvent>(channel)

      await new Promise<void>((resolve) => {
        sub.on("subscribe", async () => {
          if (history) {
            const start =
              typeof history === "object" && history.start ? String(history.start) : "-"
            const end =
              typeof history === "object" && history.end ? String(history.end) : "+"
            const limit = typeof history === "object" ? history.limit : undefined

            const messages = await redis.xrange(channel, start, end, limit)

            const entries = Object.entries(messages)
            for (const [id, message] of entries) {
              if (!message.event || !events.includes(message.event)) continue

              const result = userEvent.safeParse(message)
              if (result.success) onData(result.data)
            }

            if (entries.length > 0) {
              lastHistoryId = entries[entries.length - 1]?.[0] ?? null
            }
          }

          for (const message of buffer) {
            if (lastHistoryId && compareStreamIds(message.id, lastHistoryId) <= 0)
              continue
            onData(message)
          }

          buffer.length = 0
          isHistoryReplayed = true
          startPingInterval()
          resolve()
        })
      })

      sub.on("message", ({ message }) => {
        if (!message.event || !events.includes(message.event)) return

        const result = userEvent.safeParse(message)
        if (!result.success) return

        if (!isHistoryReplayed) {
          buffer.push(result.data)
        } else {
          onData(result.data)
        }
      })

      sub.on("unsubscribe", () => {
        stopPingInterval()
      })

      unsubscribe = () => sub.unsubscribe()
      return () => sub.unsubscribe()
    }

    const findSchema = (path: string[]): z.$ZodType | undefined => {
      let current: any = this._schema

      for (const key of path) {
        if (!current || typeof current !== "object") return undefined
        current = current[key]
      }

      return current?._zod || current?._def ? current : undefined
    }

    handlers.emit = async (event: string, data: any) => {
      const pathParts = event.split(".")
      const schema = findSchema(pathParts)

      if (schema) {
        z.parse(schema, data)
      }

      if (!this._redis) {
        this._logger.warn("No Redis instance provided to Realtime.")
        return
      }

      const id = await this._redis.xadd(
        channel,
        "*",
        { data, event, channel } as Record<string, unknown>,
        {
          ...(this._trimConfig && { trim: this._trimConfig }),
        }
      )

      const payload: UserEvent = {
        data,
        event,
        channel,
        id,
      }

      const pipeline = this._redis.pipeline()

      if (this._history.expireAfterSecs) {
        pipeline.expire(channel, this._history.expireAfterSecs)
      }

      pipeline.publish(channel, payload)

      await pipeline.exec()

      this._logger.log(`⬆️  Emitted event:`, {
        id,
        data,
        event,
        channel,
      })
    }

    return handlers
  }

  channel<N extends string>(channel: N): RealtimeChannel<T> {
    if (!this.channels[channel]) {
      this.channels[channel] = this.createEventHandlers(channel)
    }

    return this.channels[channel]
  }
}

type SchemaPaths<T, Prefix extends string = ""> = {
  [K in keyof T]: K extends string
    ? T[K] extends z.$ZodType
      ? Prefix extends ""
        ? K
        : `${Prefix}${K}`
      : T[K] extends object
      ? SchemaPaths<T[K], `${Prefix}${K}.`>
      : never
    : never
}[keyof T]

export type EventPath<T extends Opts> = T["schema"] extends Schema
  ? SchemaPaths<T["schema"]>
  : never

type SchemaValue<T, Path extends string> = Path extends `${infer First}.${infer Rest}`
  ? First extends keyof T
    ? SchemaValue<T[First], Rest>
    : never
  : Path extends keyof T
  ? T[Path]
  : never

export type EventData<T extends Opts, K extends string> = T["schema"] extends Schema
  ? SchemaValue<T["schema"], K> extends z.$ZodType
    ? z.infer<SchemaValue<T["schema"], K>>
    : never
  : never

export type HistoryMessage = {
  id: string
  event: string
  channel: string
  data: unknown
}

type SubscribeArgs<T extends Opts, E extends EventPaths<T["schema"]>> = {
  events: readonly E[]
  onData: (arg: EventPayloadUnion<T["schema"], E>) => void
  history?: boolean | HistoryArgs
}

type RealtimeChannel<T extends Opts> = {
  subscribe: <E extends EventPaths<T["schema"]>>(
    args: SubscribeArgs<T, E>
  ) => Promise<() => void>
  unsubscribe: () => void
  emit: <K extends EventPath<T>>(event: K, data: EventData<T, K>) => Promise<void>
  history: (params?: HistoryArgs) => Promise<HistoryMessage[]>
}

export type Realtime<T extends Opts> = RealtimeBase<T> & {
  channel: (name: string) => RealtimeChannel<T>
} & RealtimeChannel<T>

type InferSchemaRecursive<T> = {
  [K in keyof T]: T[K] extends z.$ZodType
    ? z.infer<T[K]>
    : T[K] extends object
    ? InferSchemaRecursive<T[K]>
    : never
}

export type InferSchema<T extends Schema> = InferSchemaRecursive<T>

export type InferRealtimeEvents<T> = T extends Realtime<infer R>
  ? NonNullable<R["schema"]>
  : never

export const Realtime = RealtimeBase as new <T extends Opts>(data?: T) => Realtime<T>

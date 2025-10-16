import { type Redis } from "@upstash/redis"
import * as z from "zod/v4/core"
import type { UserEvent } from "../types.js"
import { json, StreamingResponse } from "./handler.js"

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
  private _idBuffer: Set<string> = new Set()
  private _lastTimestamp: number = 0

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

  private generateStreamId(): string {
    const timestamp = Date.now()
    
    if (timestamp !== this._lastTimestamp) {
      this._idBuffer.clear()
      this._lastTimestamp = timestamp
    }

    let sequence = 0
    let id = `${timestamp}-${sequence}`

    while (this._idBuffer.has(id)) {
      sequence++
      id = `${timestamp}-${sequence}`
    }

    this._idBuffer.add(id)
    return id
  }

  private createEventHandlers(channel: string): any {
    const handlers: any = {}
    let historyFetchedAt: number

    const fetchHistory = async (params?: { length?: number; since?: number }) => {
      const redis = this._redis
      if (!redis) throw new Error("Redis not configured.")

      const channelKey = `channel:${channel}`
      const start = params?.since ? String(params.since) : "-"
      const count = params?.length

      const history = await redis.xrevrange(channelKey, "+", start, count)

      const messages = Object.entries(history)
      const oldestToNewestMessages = reverse(messages)

      return oldestToNewestMessages
        .map(([__stream_id, value]) => {
          if (typeof value === "object" && value !== null) {
            const { __event_path, data } = value as Record<string, unknown>
            return {
              data,
              __event_path: __event_path as string[],
              __stream_id,
              __channel: channel,
            }
          }
          return null
        })
        .filter(Boolean)
    }

    const matchesEventPath = (messagePath: string[], filterPath: string[]): boolean => {
      if (filterPath.length > messagePath.length) return false
      return filterPath.every((part, i) => part === messagePath[i])
    }

    handlers.history = (params?: { length?: number; since?: number }) => {
      const historyPromise = fetchHistory(params)

      return {
        then: <TResult1 = any, TResult2 = never>(
          onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
        ) => historyPromise.then(onfulfilled, onrejected),

        catch: <TResult = never>(
          onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null
        ) => historyPromise.catch(onrejected),

        finally: (onfinally?: (() => void) | null) => historyPromise.finally(onfinally),

        on: async (path: string, handler: (data: any) => any) => {
          const redis = this._redis
          if (!redis) throw new Error("Redis not configured.")

          const eventPath = path.split(".")
          const channelKey = `channel:${channel}`

          const processedIds = new Set<string>()
          let isProcessingHistory = true

          const sub = redis.subscribe(channelKey)

          await new Promise<void>((resolve) => {
            sub.on("subscribe", () => {
              this._logger.log("✅ Subscribed to channel:", channelKey)
              resolve()
            })
          })

          const messageBuffer: any[] = []

          sub.on("message", ({ channel, message }) => {
            if (typeof message === "object" && message !== null) {
              const { __stream_id, __event_path, data } = message as any
              const messageEventPath = __event_path as string[]

              if (matchesEventPath(messageEventPath, eventPath)) {
                if (isProcessingHistory) {
                  messageBuffer.push({ __stream_id, data })
                } else {
                  if (!processedIds.has(__stream_id)) {
                    processedIds.add(__stream_id)
                    handler(data)
                  }
                }
              }
            }
          })

          const messages = await historyPromise

          for (const msg of messages) {
            if (msg && matchesEventPath(msg.__event_path, eventPath)) {
              processedIds.add(msg.__stream_id)
              await handler(msg.data)
            }
          }

          isProcessingHistory = false

          for (const bufferedMsg of messageBuffer) {
            if (!processedIds.has(bufferedMsg.__stream_id)) {
              processedIds.add(bufferedMsg.__stream_id)
              await handler(bufferedMsg.data)
            }
          }

          processedIds.clear()

          return sub
        },
      }
    }

    handlers.on = async (path: string, handler: (data: any) => any) => {
      const redis = this._redis
      if (!redis) throw new Error("Redis not configured.")

      const eventPath = path.split(".")

      const channelKey = `channel:${channel}`
      const sub = redis.subscribe(channelKey)

      await new Promise<void>((resolve) => {
        sub.on("subscribe", () => {
          this._logger.log("✅ Subscribed to channel:", channelKey)
          resolve()
        })
      })

      sub.on("message", ({ channel, message }) => {
        if (typeof message === "object" && message !== null) {
          const { __stream_id, __event_path, data } = message as any

          const userEvent: UserEvent = {
            data,
            __event_path: __event_path as string[],
            __stream_id: __stream_id as string,
            __channel: channel,
          }

          const messageEventPath = __event_path as string[]
          if (matchesEventPath(messageEventPath, eventPath)) {
            handler(userEvent.data)
          }
        }
      })

      return sub
    }

    const findSchema = (path: string[]): z.$ZodType | undefined => {
      let current: any = this._schema
      for (const key of path) {
        if (!current || typeof current !== "object") return undefined
        current = current[key]
      }
      return current?._zod || current?._def ? current : undefined
    }

    handlers.emit = async (eventPath: string, data: any) => {
      const pathParts = eventPath.split(".")
      const schema = findSchema(pathParts)

      if (schema) {
        z.parse(schema, data)
      }

      if (!this._redis) {
        this._logger.warn("No Redis instance provided to Realtime.")
        return
      }

      const channelKey = `channel:${channel}`

      const payload = {
        data,
        __event_path: pathParts,
      }

      this._logger.log(`⬆️  Emitting event:`, {
        channel: channelKey,
        __event_path: pathParts,
        data,
      })

      const id = this.generateStreamId()

      const pipeline = this._redis.pipeline()

      pipeline.xadd(channelKey, id, payload, {
        ...(this._trimConfig && { trim: this._trimConfig }),
      })

      if (this._history.expireAfterSecs) {
        pipeline.expire(channelKey, this._history.expireAfterSecs)
      }

      await Promise.all([
        pipeline.exec(),
        this._redis.publish(channelKey, {
          data,
          __event_path: pathParts,
          __stream_id: id,
        }),
      ])
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

type SubscribeOpts<T> = {
  history?: boolean
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

type EventPath<T extends Opts> = T["schema"] extends Schema
  ? SchemaPaths<T["schema"]>
  : never

type SchemaValue<T, Path extends string> = Path extends `${infer First}.${infer Rest}`
  ? First extends keyof T
    ? SchemaValue<T[First], Rest>
    : never
  : Path extends keyof T
  ? T[Path]
  : never

type EventData<T extends Opts, K extends string> = T["schema"] extends Schema
  ? SchemaValue<T["schema"], K> extends z.$ZodType
    ? z.infer<SchemaValue<T["schema"], K>>
    : never
  : never

export type HistoryMessage = {
  data: any
  __event_path: string[]
  __stream_id: string
  __channel: string
}

export type ChainableHistory<T extends Opts> = {
  then: <TResult1 = HistoryMessage[], TResult2 = never>(
    onfulfilled?: ((value: HistoryMessage[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ) => Promise<TResult1 | TResult2>
  catch: <TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null
  ) => Promise<TResult>
  finally: (onfinally?: (() => void) | null) => Promise<HistoryMessage[]>
  on: <K extends EventPath<T>>(
    event: K,
    handler: (data: EventData<T, K>) => void
  ) => Promise<any>
}

type RealtimeChannel<T extends Opts> = {
  on: <K extends EventPath<T>>(
    events: K | Array<K>,
    handler: (data: EventData<T, K>) => void
  ) => Promise<void>
  emit: <K extends EventPath<T>>(event: K, data: EventData<T, K>) => Promise<void>
  history: (params?: { length?: number; since?: number }) => ChainableHistory<T>
}

export type Realtime<T extends Opts> = RealtimeBase<T> & {
  channel: (name: string) => RealtimeChannel<T>
} & RealtimeChannel<T> /* & {
  [K in keyof T["schema"]]: {
    [R in keyof z.infer<T["schema"][K]>]: {
      // subscribe: (
      //   handler: (data: z.infer<T["schema"][K]>[R]) => void,
      //   opts?: SubscribeOpts<T["schema"]>
      // ) => any
      emit: (value: z.infer<T["schema"][K]>[R]) => Promise<void>
    }
  }
} */

type InferSchemaRecursive<T> = {
  [K in keyof T]: T[K] extends z.$ZodType
    ? z.infer<T[K]>
    : T[K] extends object
    ? InferSchemaRecursive<T[K]>
    : never
}

export type InferSchema<T extends Schema> = InferSchemaRecursive<T>

export type InferRealtimeEvents<T> = T extends Realtime<infer R>
  ? InferSchema<NonNullable<R["schema"]>>
  : never

function reverse(array: Array<any>) {
  const length = array.length

  let left = null
  let right = null

  for (left = 0, right = length - 1; left < right; left += 1, right -= 1) {
    const temporary = array[left]
    array[left] = array[right]
    array[right] = temporary
  }

  return array
}

export const Realtime = RealtimeBase as new <T extends Opts>(data?: T) => Realtime<T>

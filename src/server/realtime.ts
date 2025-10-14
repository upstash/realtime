import { type Redis } from "@upstash/redis"
import * as z from "zod/v4/core"

const DEFAULT_VERCEL_FLUID_TIMEOUT = 300

type Schema = Record<string, z.$ZodObject>

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
    for (const [outerKey, zodObject] of Object.entries(this._schema)) {
      handlers[outerKey] = {}
      for (const innerKey of Object.keys(zodObject._zod.def.shape)) {
        handlers[outerKey][innerKey] = {
          emit: async (data: any) => {
            if (zodObject._zod.def.shape[innerKey]) {
              z.parse(zodObject._zod.def.shape[innerKey], data)
            }

            if (!this._redis) {
              this._logger.warn("No Redis instance provided to Realtime.")
              return
            }

            const eventPath = [outerKey, innerKey]
            const channelKey = `channel:${channel}`

            const payload = {
              data,
              __event_path: eventPath,
            }

            this._logger.log(`⬆️  Emitting event:`, {
              channel,
              __event_path: eventPath,
              data,
            })

            const pipeline = this._redis.pipeline()

            pipeline.xadd(channelKey, "*", payload, {
              ...(this._trimConfig && { trim: this._trimConfig }),
            })

            if (this._history.expireAfterSecs) {
              pipeline.expire(channelKey, this._history.expireAfterSecs)
            }

            const [id] = await pipeline.exec<[string, ...(string | number)[]]>()

            await this._redis.publish(channelKey, {
              data,
              __event_path: eventPath,
              __stream_id: id,
            })
          },
        }
      }
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

type RealtimeChannel<T extends Opts> = {
  [K in keyof T["schema"]]: {
    [R in keyof z.infer<T["schema"][K]>]: {
      emit: (value: z.infer<T["schema"][K]>[R]) => Promise<void>
    }
  }
}

export type Realtime<T extends Opts> = RealtimeBase<T> & {
  channel: (name: string) => RealtimeChannel<T>
} & {
  [K in keyof T["schema"]]: {
    [R in keyof z.infer<T["schema"][K]>]: {
      emit: (value: z.infer<T["schema"][K]>[R]) => Promise<void>
    }
  }
}

export type InferSchema<T extends Schema> = {
  [K in keyof T]: z.infer<T[K]>
}

export type InferRealtimeEvents<T> = T extends Realtime<infer R>
  ? InferSchema<NonNullable<R["schema"]>>
  : never

export const Realtime = RealtimeBase as new <T extends Opts>(data?: T) => Realtime<T>

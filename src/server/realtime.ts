import { type Redis } from "@upstash/redis"
import z from "zod/v4"

const DEFAULT_VERCEL_FREE_PLAN_TIMEOUT = 10

type Schema = Record<string, z.ZodObject>

export type Opts = {
  schema?: Schema
  redis?: Redis | undefined
  maxDurationSecs?: number
  verbose?: boolean
}

class RealtimeBase<T extends Opts> {
  private channels: Record<string, any> = {}
  private _schema: Schema
  private _verbose: boolean

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
    this._maxDurationSecs = data.maxDurationSecs ?? DEFAULT_VERCEL_FREE_PLAN_TIMEOUT
    this._verbose = data.verbose ?? false

    Object.assign(this, this.createEventHandlers("default"))
  }

  private createEventHandlers(channel: string): any {
    const handlers: any = {}
    for (const [outerKey, zodObject] of Object.entries(this._schema)) {
      handlers[outerKey] = {}
      for (const innerKey of Object.keys(zodObject.shape)) {
        handlers[outerKey][innerKey] = {
          emit: async (value: any) => {
            zodObject.shape[innerKey]?.parse(value)

            if (!this._redis) {
              this._logger.warn("No Redis instance provided to Realtime.")
              return
            }

            const payload = {
              data: value,
              event: innerKey,
            }

            const id = await this._redis.xadd(`channel:${channel}`, "*", payload, {
              trim: { type: "MAXLEN", threshold: 100, comparison: "~" },
            })

            await this._redis.publish(`channel:${channel}:event:${outerKey}-${innerKey}`, {
              data: value,
              __event_path: [outerKey, innerKey],
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

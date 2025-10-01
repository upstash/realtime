import { type Redis } from "@upstash/redis"
import z from "zod/v4"

const DEFAULT_VERCEL_FREE_PLAN_TIMEOUT = 10

export type Opts = {
  schema?: z.ZodObject<any, any>
  redis?: Redis | undefined
  maxDurationSecs?: number
}

class RealtimeBase<T extends Opts> {
  private namespaces: Record<string, any> = {}
  private schema: any
  
  /** @internal */
  public readonly _redis?: Redis | undefined
  
  /** @internal */
  public readonly _maxDurationSecs: number

  constructor(data: T) {
    Object.assign(this, data)
    this.schema = data.schema || z.object({})
    this._redis = data.redis
    this._maxDurationSecs = data.maxDurationSecs ?? DEFAULT_VERCEL_FREE_PLAN_TIMEOUT

    Object.assign(this, this.createEventHandlers("default"))
  }

  private createEventHandlers(namespace: string): any {
    const handlers: any = {}
    for (const key of Object.keys(this.schema.shape)) {
      handlers[key] = {
        emit: async (value: any) => {
          this.schema.shape[key].parse(value)

          if (!this._redis) {
            console.warn("No Redis instance provided to Realtime.")
            return
          }

          const id = await this._redis.xadd(`namespace:${namespace}`, "*", {
            ...value,
            event: key,
          })
          await this._redis.publish(`namespace:${namespace}:event:${key}`, {
            ...value,
            __event_id: key,
            __stream_id: id,
          })
        },
      }
    }
    return handlers
  }

  namespace<N extends string>(namespace: N): RealtimeNamespace<T> {
    if (!this.namespaces[namespace]) {
      this.namespaces[namespace] = this.createEventHandlers(namespace)
    }
    return this.namespaces[namespace]
  }
}

type RealtimeNamespace<T extends Opts> = {
  [K in keyof z.infer<T["schema"]>]: {
    emit: (value: z.infer<T["schema"]>[K]) => Promise<void>
  }
}

export type Realtime<T extends Opts> = RealtimeBase<T> & {
  namespace: (name: string) => RealtimeNamespace<T>
} & {
  [K in keyof z.infer<T["schema"]>]: {
    emit: (value: z.infer<T["schema"]>[K]) => Promise<void>
  }
}

export const Realtime = RealtimeBase as new <T extends Opts>(data?: T) => Realtime<T>

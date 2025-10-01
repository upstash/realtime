export type SystemEvent =
  | { type: "connected"; channel: string; cursor?: string }
  | { type: "reconnect" }
  | { type: "ping" }
  | { type: "error"; error: string }
  | { type: "disconnected"; channel: string }

export type UserEvent<T = unknown> = {
  data: T
  __event_path: string[]
  __stream_id: string
}

export type RealtimeMessage<T = unknown> = SystemEvent | UserEvent<T>

export type ConnectionStatus = "connected" | "disconnected" | "error" | "connecting"

export const isSystemEvent = (msg: RealtimeMessage): msg is SystemEvent => {
  return "type" in msg
}

export const isUserEvent = <T = unknown>(msg: RealtimeMessage<T>): msg is UserEvent<T> => {
  return "__event_path" in msg && "__stream_id" in msg
}


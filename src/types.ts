export type SystemEvent =
  | { type: "connected"; channel: string; cursor?: string }
  | { type: "reconnect" }
  | { type: "error"; error: string }
  | { type: "disconnected"; channel: string }
  | { type: "ping"; timestamp: number }

export type UserEvent<T = unknown> = {
  data: T
  __event_path: string[]
  __stream_id: string
}

export type RealtimeMessage<T = unknown> = SystemEvent | UserEvent<T>

export type ConnectionStatus = "connected" | "disconnected" | "error" | "connecting"
/**
 * Appends an event to the channel stream and publishes it in one round trip.
 *
 * The stream id is only known once XADD has run, so the publish payload is
 * assembled inside the script. Running both in one script also makes pub/sub
 * delivery order match stream order for concurrent emits.
 *
 * Upstash runs a script under the database-wide lock unless it declares
 * `allow-key-locking`. With the flag only the channel is locked: emits to one
 * channel still run one after another, and nothing else in the database waits
 * for them. The flag requires every key the script touches to be in KEYS.
 * Stock Redis rejects the flag, so the script only runs on Upstash.
 *
 * KEYS[1] channel
 * ARGV[1] stream `data` field
 * ARGV[2] event name
 * ARGV[3] publish payload up to the opening quote of the id
 * ARGV[4] MAXLEN threshold, or "" to keep the stream untrimmed
 * ARGV[5] EXPIRE seconds, or "" to leave the TTL alone
 * ARGV[6] "1" when ARGV[1] is the JSON the payload carries as `data`, so the
 *         data is sent once instead of twice
 */
export const EMIT_SCRIPT = `#!lua flags=allow-key-locking
local id
if ARGV[4] == '' then
  id = redis.call('XADD', KEYS[1], '*', 'data', ARGV[1], 'event', ARGV[2], 'channel', KEYS[1])
else
  id = redis.call('XADD', KEYS[1], 'MAXLEN', '=', ARGV[4], '*', 'data', ARGV[1], 'event', ARGV[2], 'channel', KEYS[1])
end
if ARGV[5] ~= '' then
  redis.call('EXPIRE', KEYS[1], ARGV[5])
end
local payload = ARGV[3]
if ARGV[6] == '1' then
  payload = '{"data":' .. ARGV[1] .. payload
end
redis.call('PUBLISH', KEYS[1], payload .. id .. '"}')
return id`

/**
 * SHA-1 of EMIT_SCRIPT, precomputed so the first emit of a cold start can go
 * straight to EVALSHA. test/emit.test.js fails if the two drift apart.
 */
export const EMIT_SCRIPT_SHA = "debff4bc1daa72e023dc03d88231e67d24899840"

export function isMissingScriptError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  // The SDK appends the failed command to some error messages. Only the part
  // Redis wrote counts, or a payload containing "NOSCRIPT" would match.
  const [reason = ""] = error.message.split(", command was:")
  return reason.includes("NOSCRIPT")
}

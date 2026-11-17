/**
 * Appends an event to the channel stream and publishes it in one round trip.
 *
 * The stream id is only known once XADD has run, so the publish payload is
 * assembled inside the script. Running both in one script also makes pub/sub
 * delivery order match stream order for concurrent emits.
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
export const EMIT_SCRIPT = `local id
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
export const EMIT_SCRIPT_SHA = "6b35869b615340b32e0a4b978a96f8a8f6995853"

export function isMissingScriptError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  // The SDK appends the failed command to some error messages. Only the part
  // Redis wrote counts, or a payload containing "NOSCRIPT" would match.
  const [reason = ""] = error.message.split(", command was:")
  return reason.includes("NOSCRIPT")
}

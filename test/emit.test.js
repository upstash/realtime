import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import * as z from "zod"

import { Realtime } from "../src/server/index.js"
import { EMIT_SCRIPT, EMIT_SCRIPT_SHA } from "../src/server/scripts.js"

function setup({ evalshaError, ...options } = {}) {
  const calls = []
  const redis = {
    async evalsha(...args) {
      calls.push(["evalsha", ...args])
      if (evalshaError) throw evalshaError
      return "5-0"
    },
    async eval(...args) {
      calls.push(["eval", ...args])
      return "6-0"
    },
  }

  return { calls, realtime: new Realtime({ redis, ...options }) }
}

test("the precomputed sha matches the script", () => {
  expect(createHash("sha1").update(EMIT_SCRIPT).digest("hex")).toBe(EMIT_SCRIPT_SHA)
})

test("emits with a single script call", async () => {
  const { calls, realtime } = setup()

  await realtime.channel("room").emit("message", { text: "hi" })

  expect(calls).toEqual([
    [
      "evalsha",
      EMIT_SCRIPT_SHA,
      ["room"],
      ['{"text":"hi"}', "message", ',"event":"message","channel":"room","id":"', "", "", "1"],
    ],
  ])
})

test("the script arguments rebuild the published payload", async () => {
  const cases = [{ text: 'say "hi"' }, [1, null], null, "plain", "123", 42, true]

  for (const data of cases) {
    const { calls, realtime } = setup()
    await realtime.channel('room "1"').emit("chat.message", data)

    const [, , , [field, , prefix, , , isShared]] = calls[0]
    const payload = (isShared === "1" ? `{"data":${field}${prefix}` : prefix) + '5-0"}'

    expect(JSON.parse(payload)).toEqual({
      data,
      event: "chat.message",
      channel: 'room "1"',
      id: "5-0",
    })
    // The stream field is what the SDK would have stored for xadd.
    expect(field).toBe(typeof data === "object" ? JSON.stringify(data) : data)
  }
})

test("passes the history options to the script", async () => {
  const { calls, realtime } = setup({ history: { maxLength: 100, expireAfterSecs: 60 } })

  await realtime.emit("message", { text: "hi" })

  expect(calls[0][3].slice(3, 5)).toEqual(["100", "60"])
})

test("loads the script when it is not cached", async () => {
  const { calls, realtime } = setup({
    evalshaError: new Error("Command failed: NOSCRIPT No matching script. Please use EVAL."),
  })

  await realtime.emit("message", { text: "hi" })

  expect(calls.map(([command]) => command)).toEqual(["evalsha", "eval"])
  expect(calls[1][1]).toBe(EMIT_SCRIPT)
  expect(calls[1].slice(2)).toEqual(calls[0].slice(2))
})

test("surfaces other script errors without retrying", async () => {
  const error = new Error("ERR max request size exceeded")
  const { calls, realtime } = setup({ evalshaError: error })

  await expect(realtime.emit("message", { text: "hi" })).rejects.toBe(error)
  expect(calls).toHaveLength(1)
})

test("validates against the schema before touching Redis", async () => {
  const { calls, realtime } = setup({ schema: { message: z.object({ text: z.string() }) } })

  await expect(realtime.emit("message", { text: 1 })).rejects.toThrow()
  expect(calls).toHaveLength(0)
})

test("does not mistake a payload for a missing-script error", async () => {
  // The SDK quotes the failed command, payload included, in its error message.
  const error = new Error(
    'ERR max request size exceeded, command was: [["evalsha","sha",1,"room","{\\"text\\":\\"NOSCRIPT\\"}"]]'
  )
  const { calls, realtime } = setup({ evalshaError: error })

  await expect(realtime.emit("message", { text: "NOSCRIPT" })).rejects.toBe(error)
  expect(calls.map(([command]) => command)).toEqual(["evalsha"])
})

test("refuses an event that is too large to be delivered", async () => {
  for (const data of [{ blob: "x".repeat(1_000_000) }, "x".repeat(1_000_000)]) {
    const { calls, realtime } = setup()

    const error = await realtime.emit("message", data).then(
      () => new Error("Expected the emit to reject"),
      (cause) => cause
    )

    expect(error).toBeInstanceOf(RangeError)
    expect(error.message).toContain('Event "message" is too large to publish')
    expect(error.message).toContain("the limit is 1000000")
    // Nothing was stored or published.
    expect(calls).toHaveLength(0)
  }
})

test("accepts an event just under the size limit", async () => {
  for (const data of [{ blob: "x".repeat(999_900) }, "x".repeat(999_900)]) {
    const { calls, realtime } = setup()

    await realtime.emit("message", data)

    expect(calls).toHaveLength(1)
  }
})

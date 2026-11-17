import { expect, test } from "bun:test"

import { startKeepalive } from "../src/server/keepalive.js"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function setup(options = {}) {
  const pings = []
  let unresponsive = 0
  const keepalive = startKeepalive({
    ping: async () => {
      pings.push(Date.now())
    },
    idleMs: 40,
    jitterMs: 0,
    echoTimeoutMs: 30,
    ...options,
    ...(options.detect && {
      onUnresponsive: () => {
        unresponsive += 1
        options.detect(keepalive)
      },
    }),
  })

  return { keepalive, pings, unresponsive: () => unresponsive }
}

test("pings once the subscription has been idle", async () => {
  const { keepalive, pings } = setup()

  await sleep(70)
  keepalive.stop()

  expect(pings).toHaveLength(1)
})

test("does not ping while there is traffic", async () => {
  const { keepalive, pings } = setup()

  for (let index = 0; index < 8; index++) {
    await sleep(15)
    keepalive.touch()
  }
  keepalive.stop()

  expect(pings).toHaveLength(0)
})

test("pings again after the traffic stops", async () => {
  const { keepalive, pings } = setup()

  await sleep(20)
  keepalive.touch()
  await sleep(30)
  expect(pings).toHaveLength(0)

  await sleep(40)
  keepalive.stop()

  expect(pings).toHaveLength(1)
})

test("reports a subscription that does not echo the ping", async () => {
  const { keepalive, unresponsive } = setup({ detect: (keepalive) => keepalive.stop() })

  await sleep(120)
  keepalive.stop()

  expect(unresponsive()).toBe(1)
})

test("treats an echoed ping as a healthy subscription", async () => {
  let keepalive
  let unresponsive = 0
  let pings = 0

  keepalive = startKeepalive({
    ping: async () => {
      pings += 1
      // The ping comes back through the subscription shortly after.
      setTimeout(() => keepalive.touch(), 5)
    },
    onUnresponsive: () => {
      unresponsive += 1
    },
    idleMs: 40,
    jitterMs: 0,
    echoTimeoutMs: 30,
  })

  await sleep(150)
  keepalive.stop()

  expect(pings).toBeGreaterThanOrEqual(2)
  expect(unresponsive).toBe(0)
})

test("stops pinging once stopped", async () => {
  const { keepalive, pings } = setup()

  keepalive.stop()
  await sleep(70)

  expect(pings).toHaveLength(0)
})

test("is not thrown off by the wall clock being adjusted", async () => {
  const realNow = Date.now
  const { keepalive, pings } = setup()

  try {
    // An hour backwards, then an hour forwards: neither should move the ping.
    Date.now = () => realNow() - 3_600_000
    await sleep(25)
    expect(pings).toHaveLength(0)

    Date.now = () => realNow() + 3_600_000
    await sleep(10)
    expect(pings).toHaveLength(0)

    await sleep(35)
    expect(pings).toHaveLength(1)
  } finally {
    Date.now = realNow
    keepalive.stop()
  }
})

test("reports the last arrival as a wall-clock time", async () => {
  const { keepalive } = setup({ idleMs: 10_000 })

  await sleep(20)
  keepalive.touch()
  const touchedAt = Date.now()
  await sleep(20)

  expect(Math.abs(keepalive.lastArrivalAt() - touchedAt)).toBeLessThan(10)
  keepalive.stop()
})

test("retries a ping that failed to publish without waiting out another idle period", async () => {
  const attempts = []
  const keepalive = startKeepalive({
    ping: async () => {
      attempts.push(Date.now())
      if (attempts.length === 1) throw new Error("fetch failed")
    },
    idleMs: 60,
    jitterMs: 0,
    retryMs: 10,
  })

  await sleep(100)
  keepalive.stop()

  expect(attempts).toHaveLength(2)
  expect(attempts[1] - attempts[0]).toBeLessThan(40)
})

test("backs off while pings keep failing", async () => {
  const attempts = []
  const keepalive = startKeepalive({
    ping: async () => {
      attempts.push(Date.now())
      throw new Error("fetch failed")
    },
    idleMs: 60,
    jitterMs: 0,
    retryMs: 8,
  })

  await sleep(330)
  keepalive.stop()

  const gaps = attempts.slice(1).map((time, index) => time - attempts[index])
  // Three quick retries about 8ms apart, then 16, 32, and capped at the idle period.
  expect(gaps.length).toBeGreaterThanOrEqual(6)
  expect(Math.max(...gaps.slice(0, 3))).toBeLessThan(16)
  expect(gaps[4]).toBeGreaterThan(gaps[2] + 8)
  expect(gaps[5]).toBeGreaterThan(gaps[4])
  expect(Math.max(...gaps)).toBeLessThan(90)
})

test("follows an idle period that changes while running", async () => {
  let idleMs = 10_000
  const pings = []
  const keepalive = startKeepalive({
    ping: async () => {
      pings.push(Date.now())
    },
    idleMs: () => idleMs,
    jitterMs: 0,
  })

  await sleep(30)
  expect(pings).toHaveLength(0)

  // Already idle longer than the new period: pinged as soon as it applies.
  idleMs = 20
  keepalive.refresh()
  await sleep(5)
  expect(pings).toHaveLength(1)

  keepalive.stop()
})

test("refreshing does not start a second timer or disturb a pending echo check", async () => {
  let unresponsive = 0
  let pings = 0
  const keepalive = startKeepalive({
    ping: async () => {
      pings += 1
    },
    onUnresponsive: () => {
      unresponsive += 1
      keepalive.stop()
    },
    idleMs: 20,
    jitterMs: 0,
    echoTimeoutMs: 30,
  })

  await sleep(30)
  // The ping is out and its echo is being awaited.
  keepalive.refresh()
  keepalive.refresh()
  await sleep(50)

  expect(pings).toBe(1)
  expect(unresponsive).toBe(1)
})

test("a ping that never settles is retried instead of ending the keepalive", async () => {
  let attempts = 0
  const keepalive = startKeepalive({
    ping: () => {
      attempts += 1
      // The first publish hangs forever.
      return attempts === 1 ? new Promise(() => {}) : Promise.resolve()
    },
    idleMs: 20,
    jitterMs: 0,
    pingTimeoutMs: 20,
    retryMs: 5,
  })

  await sleep(80)
  keepalive.stop()

  expect(attempts).toBeGreaterThanOrEqual(2)
})

test("a ping that throws synchronously is treated as failed", async () => {
  let attempts = 0
  const keepalive = startKeepalive({
    ping: () => {
      attempts += 1
      if (attempts === 1) throw new Error("serialization failed")
      return Promise.resolve()
    },
    idleMs: 20,
    jitterMs: 0,
    retryMs: 5,
  })

  await sleep(60)
  keepalive.stop()

  expect(attempts).toBeGreaterThanOrEqual(2)
})

test("an arrival that is not passed on answers a ping but does not postpone one", async () => {
  let unresponsive = 0
  const pings = []
  const keepalive = startKeepalive({
    ping: async () => {
      pings.push(Date.now())
    },
    onUnresponsive: () => {
      unresponsive += 1
    },
    idleMs: 40,
    jitterMs: 0,
    echoTimeoutMs: 20,
  })

  const arrivals = setInterval(() => keepalive.alive(), 10)
  await sleep(110)
  clearInterval(arrivals)
  keepalive.stop()

  expect(pings.length).toBeGreaterThanOrEqual(1)
  expect(unresponsive).toBe(0)
})

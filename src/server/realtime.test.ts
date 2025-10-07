import { test, describe, expect } from 'bun:test'
import { Realtime } from './realtime.js'
import { Redis } from '@upstash/redis'
import z from 'zod/v4'

// Helper to create Redis instance for testing
// You can replace these with your actual Redis credentials
const createTestRedis = () => {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  })
}

// Helper to wait for a short period
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Helper to generate unique channel names for tests
const getTestChannel = () => `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

describe('createEventHandlers', () => {
  test('should create event handlers with proper structure', async () => {
    const schema = {
      user: z.object({
        created: z.object({ id: z.string(), name: z.string() }),
        updated: z.object({ id: z.string(), changes: z.record(z.string(), z.any()) }),
      }),
      message: z.object({
        sent: z.object({ content: z.string(), userId: z.string() }),
      }),
    }

    const realtime = new Realtime({
      schema,
      redis: createTestRedis(),
      verbose: false,
    })

    // Test default channel handlers
    expect(realtime.user).toBeTruthy()
    expect(realtime.user.created).toBeTruthy()
    expect(realtime.user.updated).toBeTruthy()
    expect(realtime.message).toBeTruthy()
    expect(realtime.message.sent).toBeTruthy()

    // Test emit function exists
    expect(typeof realtime.user.created.emit).toBe('function')
    expect(typeof realtime.user.updated.emit).toBe('function')
    expect(typeof realtime.message.sent.emit).toBe('function')

    // @ts-expect-error ignoring type error for non-existent handler
    expect(typeof realtime.somethingElse).toBe('undefined')
  })

  test('should emit events and store them in Redis stream', async () => {
    const redis = createTestRedis()
    const testChannel = getTestChannel()
    
    const schema = {
      user: z.object({
        created: z.object({ id: z.string(), name: z.string() }),
      }),
    }

    const realtime = new Realtime({
      schema,
      redis,
      verbose: false,
    })

    const userData = { id: 'user-123', name: 'John Doe' }
    
    // Emit an event
    await realtime.channel(testChannel).user.created.emit(userData)

    // Wait a bit for the operations to complete
    await wait(100)

    // Verify the event was added to the stream using XRANGE
    const streamKey = `channel:${testChannel}`
    const streamEntries = await redis.xrange(streamKey, '-', '+')
    
    // streamEntries is Record<streamId, Record<field, value>>
    const streamIds = Object.keys(streamEntries)
    expect(streamIds.length).toBe(1)
    
    const firstStreamId = streamIds[0]!
    const fields = streamEntries[firstStreamId] as Record<string, unknown>

    expect(fields).toBeTruthy() // Should exist
    
    // Verify the stream entry contains the expected data
    expect(JSON.stringify(fields.data)).toBe(JSON.stringify(userData))
    expect(JSON.stringify(fields.__event_path)).toBe(JSON.stringify(['user', 'created']))
    
    // Clean up
    await redis.del(streamKey)
  })

  test('should publish events and verify by checking stream', async () => {
    const redis = createTestRedis()
    const testChannel = getTestChannel()
    
    const schema = {
      user: z.object({
        created: z.object({ id: z.string(), name: z.string() }),
      }),
    }

    const realtime = new Realtime({
      schema,
      redis,
      verbose: false,
    })

    const userData = { id: 'user-456', name: 'Jane Doe' }
    const channelKey = `channel:${testChannel}`
    
    // Emit event using custom channel
    await realtime.channel(testChannel).user.created.emit(userData)

    // Wait for the operations to complete
    await wait(100)

    // Verify it was added to the stream and published
    const streamEntries = await redis.xrange(channelKey, '-', '+')
    const streamIds = Object.keys(streamEntries)
    expect(streamIds.length).toBe(1)
    
    const firstStreamId = streamIds[0]!
    const fields = streamEntries[firstStreamId] as Record<string, unknown>
    
    expect(JSON.stringify(fields.data)).toBe(JSON.stringify(userData))
    expect(JSON.stringify(fields.__event_path)).toBe(JSON.stringify(['user', 'created']))
    
    // Clean up
    await redis.del(channelKey)
  })

  test('should handle missing Redis gracefully', async () => {
    const schema = {
      user: z.object({
        created: z.object({ id: z.string(), name: z.string() }),
      }),
    }

    const realtime = new Realtime({
      schema,
      verbose: false, // No Redis provided
    })

    // Should not throw an error
    await realtime.user.created.emit({ id: 'user-789', name: 'Test User' })
    
    // Just verify the function exists and can be called
    expect(typeof realtime.user.created.emit).toBe('function')
  })

  test('should validate data against schema', async () => {
    const redis = createTestRedis()
    const testChannel = getTestChannel()

    const schema = {
      user: z.object({
        created: z.object({ id: z.string(), name: z.string() }),
      }),
    }

    const realtime = new Realtime({
      schema,
      redis,
      verbose: false,
    })

    // Valid data should work
    await realtime.channel(testChannel).user.created.emit({ id: 'user-123', name: 'John Doe' })
    
    // Verify it was stored
    const streamKey = `channel:${testChannel}`
    const streamEntries = await redis.xrange(streamKey, '-', '+')
    const streamIds = Object.keys(streamEntries)
    expect(streamIds.length).toBe(1)

    // Invalid data should throw (Zod validation error)
    expect(async () => {
      // @ts-expect-error - Testing invalid data type
      await realtime.channel(testChannel).user.created.emit({ id: 123, name: 'John Doe' })
    }).toThrow()
    
    // Clean up
    await redis.del(streamKey)
  })

  test('should publish events and verify with subscription', async () => {
    const redis = createTestRedis()
    const testChannel = getTestChannel()
    
    const schema = {
      user: z.object({
        created: z.object({ id: z.string(), name: z.string() }),
      }),
    }

    const realtime = new Realtime({
      schema,
      redis,
      verbose: false,
    })

    const userData = { id: 'user-subscriber-test', name: 'Subscriber Jane' }
    const channelKey = `channel:${testChannel}`
    
    // Set up subscription to capture published events
    const receivedMessages: any[] = []
    const subscriber = redis.subscribe([channelKey])
    
    subscriber.on('message', (data: any) => {
      receivedMessages.push(data.message)
    })

    // Wait for subscription to establish
    await wait(2000)
    
    // Emit event using custom channel
    await realtime.channel(testChannel).user.created.emit(userData)

    // Wait for the published event to be received
    await wait(1000)

    // Verify the event was published and received
    expect(receivedMessages.length).toBe(1)
    
    const publishedEvent = receivedMessages[0]
    expect(publishedEvent.data).toEqual(userData)
    expect(publishedEvent.__event_path).toEqual(['user', 'created'])
    expect(publishedEvent.__stream_id).toBeTruthy() // Should have a stream ID
    
    // Also verify it was added to the stream
    const streamEntries = await redis.xrange(channelKey, '-', '+')
    const streamIds = Object.keys(streamEntries)
    expect(streamIds.length).toBe(1)
    
    // Clean up
    await subscriber.unsubscribe()
    await redis.del(channelKey)
  }, 15_000) // Longer timeout for subscription test
})
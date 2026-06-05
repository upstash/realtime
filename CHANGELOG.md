# Changelog

## Unreleased

### Fixed

- **client:** Retain `lastAck` per channel while multiple `useRealtime` subscriptions are still active. Previously, `unregister` deleted ack state globally per channel, causing incorrect SSE replay when one hook unmounted while another still subscribed to the same channel.

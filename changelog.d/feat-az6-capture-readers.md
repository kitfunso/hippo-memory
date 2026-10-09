### Changed

- **The session-end and post-compact hooks now read their payload through the capture contract's payload readers, with conformance fixtures.** A session-end payload that starts with a byte-order mark is now read instead of dropped, and `hippo post-compact` logs that no payload arrived when stdin timed out.

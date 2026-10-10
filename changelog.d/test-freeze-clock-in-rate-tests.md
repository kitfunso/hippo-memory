### Changed

- **Internal:** two rate-limit tests now stop the clock while they count tokens, so a slow Windows runner can no longer refill a bucket between requests and turn the expected 429 into a 200.

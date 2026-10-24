### Changed

- **`hippo daily-runner` now sleeps the global store once a day, and `hippo sleep --global` sleeps it by hand.** The daily step is skipped when the store slept less than 20 hours ago, and a registered folder whose `.hippo` is the global store no longer sleeps twice.

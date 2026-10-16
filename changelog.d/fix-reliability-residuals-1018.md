### Fixed

- **A served request past its deadline now stops its queued work.** The request carries an abort signal that fires at the deadline, so a store call still waiting for a worker is dropped and a recall skips its later stages instead of running for a caller who already got the 504.

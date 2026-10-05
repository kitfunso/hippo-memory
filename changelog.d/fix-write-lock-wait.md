### Fixed

- **Two hippo processes writing to one store at once now take turns instead of failing with "database is locked".** A write used to start by reading the store and only then ask for the write lock, and SQLite does not wait for the lock in that case. Every write now asks for the lock first, so it waits up to the store's usual lock wait (5 seconds, 1 second in hooks, 250 ms in the server). Two processes writing 60 memories each into one store used to crash the second one every time; both now finish with all 120 memories saved.

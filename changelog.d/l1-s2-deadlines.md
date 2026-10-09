### Changed

- **`hippo serve` now answers every `/v1` and `/mcp` request by a deadline.** A request still running after 120 s gets `504` with `{ "error", "code": "deadline_exceeded", "requestId" }`. Set `HIPPO_REQUEST_DEADLINE_MS` to change the deadline, or to `0` to turn it off. `POST /v1/sleep` and `GET /mcp/stream` keep their own limits. For a predictions write the `error` text says whether the write was stopped with nothing saved, or whether it may or may not be saved.
- **A full store queue now refuses new work at once.** Each store worker thread lets 256 calls wait (`HIPPO_STORE_QUEUE_MAX`). The next call gets the same `503` with `Retry-After: 1` as a busy store, and so does a call still waiting in the queue at its request's deadline.
- **`POST /v1/sleep` now refuses a third concurrent sleep.** One sleep runs and one waits. A further call gets `503` with `Retry-After: 30` at once.
- **The loopback `GET /health` body has four new counts:** `store_queue_refusals`, `store_jobs_expired`, `store_workers_replaced` and `handler_deadlines`.

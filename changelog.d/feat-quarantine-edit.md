### Added

- **Edit a held memory from the review queue.** `hippo quarantine edit <id> "<text>"` and `POST /v1/quarantine/:id/edit` (admin only; a member key gets 403) approve a held memory with the admin's cleaned text. The text runs the write screen again and answers 400 when it still reads as an instruction; a second edit, or an approve after an edit, answers 409. The held row stays as delivered and is superseded by a new memory that lists it in `parents`, keeps its lead-in, artifact and trust tags, and sits under the original scope. One `quarantine_edit` audit row records `{originalScope, newId}`.

### Changed

- **`hippo quarantine` shows a held item as pending review.** The stored status stays `pending`, so `GET /v1/quarantine` is unchanged.
- **Store port:** `Quarantine` gains an optional `editQuarantined`; a store without it answers 501 for an edit.

### Added

- **Edit a held memory from the review queue.** `hippo quarantine edit <id> "<text>"` and `POST /v1/quarantine/:id/edit` (admin only; a member key gets 403) approve a held memory with the admin's cleaned text. The text runs the write screen again and answers 400 when it still reads as an instruction, alone or joined to the kept lead-in. A held row whose own lead-in reads as an instruction answers 400 too, because an edit keeps the lead-in: reject that item instead. Clean text sent twice, or an approve after an edit, answers 409. The held row stays as delivered and is superseded by a new memory that lists it in `parents`, keeps its lead-in, artifact, trust tags and confidence tier, and sits under the original scope. One `quarantine_edit` audit row records `{originalScope, newId}`.

### Changed

- **`hippo quarantine` shows a held item as pending review.** The stored status stays `pending`, so `GET /v1/quarantine` is unchanged.
- **`remember` screens the lead-in joined to the content.** A connector write whose instruction splits across the two is held, and a member's shared write split the same way is framed. Spaces and invisible marks at the join are ignored.
- **Store port:** `Quarantine` gains an optional `editQuarantined`; a store without it answers 501 for an edit.

### Added

- **A memory can carry a lead-in: the conversation text just before it.** A short memory such as "Three times a week" now keeps the question it answered. Every write surface takes it: `hippo remember --lead-in`, the `lead_in` argument of the MCP `hippo_remember` tool, `leadIn` in `POST /v1/memories`, and `lead_in=` in the Python SDK `remember`. The server cuts it to its last 2,000 characters, redacts secrets in it, and runs the instruction check over it.
- **Search and recall use the lead-in.** BM25, semantic and fallback search match words that only the lead-in holds. Recall, `hippo context`, the MCP tools and the dashboard print the lead-in above the memory, and each JSON row carries `leadIn` when it is set. The Python `MemoryEnvelope` and `RecallEntry` parse it as `lead_in`. A row with no lead-in prints and ranks as before.

### Changed

- **A lead-in is part of a row's identity.** The duplicate check and the tombstone that a rejection or a lost conflict writes key on the content plus the lead-in, so "Yes." after two different questions stays two rows. `hippo reject <id>` on a row with a lead-in refuses the text under that lead-in only, while `hippo reject --value` refuses the text everywhere. Sleep never merges a row with a lead-in into another row.
- **Schema v64 adds the nullable `lead_in` column, and the first lead-in row raises the store floor to 3.13.0.** An older binary would fold two lead-in rows into one, so it refuses a store from then on. A store with no lead-in row stays open to older binaries.
- **Fact extraction (`hippo remember --extract`) sends the lead-in to the model as marked context.** The model can then tell who and what a short memory is about. A connector row, or a row flagged as instruction-like, sends its content alone.

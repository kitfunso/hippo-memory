### Added

- **`hippo dashboard` opens on a new Health view.** It shows memory counts, strength bands, at-risk memories and open conflicts per origin project, with a treemap of projects, a strength-by-age scatter per project and a sortable memory table. You can pin, mark wrong, resolve a conflict or forget a memory from a side drawer; mark wrong, resolve and forget wait 6 seconds behind an Undo before anything is written. On a phone the view uses a card list and a bottom sheet, and nothing depends on hover.

### Changed

- **The dashboard server now computes its summaries itself and sends pages, not the whole store.** The browser no longer receives raw embedding vectors, which cuts the payload on large stores. Memories are grouped by their `origin_project`. The read path never renames or rewrites `embeddings.json`. The old `/api/memories`, `/api/embeddings`, `/api/stats`, `/api/conflicts`, `/api/peers`, `/api/config` and `/api/star/:id` routes are gone; scripts that called them should use `/api/overview`, `/api/projects/:key/memories` and `/api/memory/:id`.
- **The Board view moved onto the new shared header and colours.** Its cards and dialog work as before; on a phone the card dialog opens as a bottom sheet.
- **Removed the 3D Living Map view and its `three` and `d3-force` dependencies.** The Health view replaces it.

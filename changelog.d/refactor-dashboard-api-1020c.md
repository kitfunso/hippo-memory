### Changed

- **The dashboard cookie no longer holds the access token.** After a visit to the `?token=` URL, the browser keeps an HMAC-SHA256 of the token, keyed to the dashboard's port, so whoever reads the browser's cookie store does not get the token. The raw token sent as the cookie answers 401. Open the URL `hippo dashboard` prints, as after any restart.
- **The dashboard reads and writes through the store and the api.** It builds one store at start. Pin, mark wrong, forget and resolve call `pinMemory`, `outcome`, `forget` and `resolveMemoryConflict` in `src/api`, and a pin now writes a `pin` audit row that `hippo audit list` and `GET /v1/audit` show. Every reply keeps its shape.
- **The dashboard snapshot no longer holds every whole row.** It reads a tenant 1,000 rows at a time and keeps each row's first 240 characters and the fields the lists show. Search and the text filter read the full text a page at a time. Sorting by content now compares the first 240 characters.
- **3.0 break for a store built on `hippo-memory/store-kit`: `entryWrites.setPinned` and `localFiles.dashboard` are new.** `sqliteStore` already has both. `docs/UPGRADING-3.0.md` has the rows.

### Removed

- **`StoreContext` in `src/api`.** Use `Context`. No package entry exported it, so this touches only code that imports hippo's `src` or `dist` files directly.

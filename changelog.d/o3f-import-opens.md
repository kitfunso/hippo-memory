### Changed

- Internal: `hippo import` and the vault import no longer open the database themselves; they write and probe the rejection guard through store functions, on one shared handle per import as before.

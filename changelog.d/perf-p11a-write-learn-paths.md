### Changed

- **`hippo learn` reads the store once per batch, on one open handle.** It reloaded every row of the tenant for each lesson that names a migration and opened the store again for each write; lessons, invalidations and counts are unchanged.
- **`hippo remember`, `hippo capture` and `hippo watch` no longer load every row of the tenant on each write.** Schema fit reads tag counts from one aggregate and streams one column, the salience gate reads only its window, and capture's copy check reads only rows holding an item's longest word; output is unchanged.
- **Strengthening recalled memories reads their rows in one query.** It ran one read and one prepared update per id.

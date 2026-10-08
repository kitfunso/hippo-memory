### Tests

- **Seven test files and a 212-line snapshot that replayed a contract another test owns are gone.** Their unique assertions moved into the keeper first, and each kept contract was checked by breaking the line it guards. Misnamed tests now check what their names say. No source file changes.

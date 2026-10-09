### Changed

- **Internal:** deleting a raw row now fails with a typed `RawAppendOnlyError` that the CLI and the dashboard test with `instanceof`, in place of matching the error text. Printed lines, exit codes and status codes are unchanged.

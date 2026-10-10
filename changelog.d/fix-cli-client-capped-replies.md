### Changed

- **Internal:** the CLI's server client reads every reply under a 1 MiB cap. If the port in the pidfile now belongs to another process, a huge reply ends in an error instead of filling memory.

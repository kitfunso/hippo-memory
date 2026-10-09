### Fixed

- **Rethrown failures keep the original error as `cause`.** Git reads, embedding API calls, the TLS certificate check and trace-step parsing now carry the underlying error, so a log shows the real fault. The message text is unchanged.

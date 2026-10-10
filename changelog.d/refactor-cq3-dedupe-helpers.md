### Changed

- **Internal:** The short token fingerprint, the cosine score, the stdout and stderr log tee and the recall read rules each have one copy. A log file that stops accepting writes now warns once instead of dropping output silently. Slack replay and recall availability use the shared time constants.

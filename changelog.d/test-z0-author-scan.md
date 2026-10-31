### Fixed

- **The blind Z0 author's leak scan no longer discards on chance matches.** The `z0` pattern skips regex classes such as `[a-z0-9]` and base64 runs such as lockfile integrity hashes, and request bodies are scanned without their ciphertext (thinking signatures, redacted thinking and base64 images). A paths-and-names leak such as `C:/z0-runs` is still caught.
- **A blind author's temp folder is inside its work folder.** TEMP, TMP and TMPDIR point at `<work>/.tmp`, because the box's own temp folder holds hippo test folders and an author that lists it to find its own leftovers was discarded.

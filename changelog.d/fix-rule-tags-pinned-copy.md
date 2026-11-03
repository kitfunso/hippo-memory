### Fixed

- **A rule you state now replaces an older pinned copy of the same text that has no from-user tag.** A rule pinned by 3.1.1, before the tag existed, stopped capture from storing the rule again, so it never printed under "Rules from the user". Capture now supersedes that copy with the tagged rule, in the same project only. A pinned copy that already has the tag still stops the rule, so a replayed transcript adds nothing.

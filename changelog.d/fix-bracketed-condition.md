### Fixed

- **A condition in brackets on its own line stays with its rule.** "Always deploy to production" followed by a line "(only if p95 < 200)." was stored without the condition, so the rule read as unconditional. A bracketed line under a sentence with no stop now joins that sentence. A line that starts with an enumerator such as "(1)" does not.

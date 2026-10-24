### Fixed

- **The GitHub events webhook refuses a re-sent signed body under a fresh delivery id.** The replay hold now keys on the body signature, not the unsigned `X-GitHub-Delivery` header, so a captured delivery sent again with a new id gets 409 while the hold lasts.
- **`hippo eval` names the file and the missing field when a corpus or baseline file has the wrong shape.** It used to fail later, or with a message that did not say which file was wrong.

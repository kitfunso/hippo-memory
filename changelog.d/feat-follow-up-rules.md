### Added

- **Capture can store the rules you state in a later turn, with an opt-in model call.** Word patterns stored nothing from a correction such as "No: Clean build: `./mvnw clean package -DskipTests --batch-mode`, because the project's maintainers require it." With `{"capture": {"followUpRules": "model"}}` in `.hippo/config.json` and `ANTHROPIC_API_KEY` set, a session capture sends your turns after the first one, the last 20, to Anthropic in one call. The model returns sentence numbers only, so hippo stores your own sentences, as pinned rules tagged `follow-up` and `from-user`. Pasted blocks, fenced code and log lines are removed before the call, and secrets, email addresses and home paths are masked. Each picked rule meets the same checks as a pattern rule, and a pattern rule it holds is not stored a second time. The default is `"off"`. A capture after each reply (`--turn`) never calls the model.

### Known limitations

- A picked sentence that holds a home path is stored with the path masked, so it can sit beside the pattern rule that kept the path.
- A rule picked from two or more sentences holds more than any older row of one of them, so it is stored beside that row.

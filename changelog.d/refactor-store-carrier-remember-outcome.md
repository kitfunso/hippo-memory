### Changed

- **An outcome over several ids now commits as one transaction on the CLI and SDK path.** `hippo outcome`, the dashboard and `outcome` on a context with no store used to commit each row alone, so a row refused midway left the earlier rows changed. Now every row and its audit row commit together or not at all, as they already did through a served store. The link to the recall trace is still written after the commit.
- **A refused outcome leaves its `reject_refusal` audit row through a served store too.** `POST /v1/outcome` used to roll the outcome back and record nothing; it now records the refusal the same way the CLI does.
- **`remember` with no store refuses an id that another tenant already holds.** It throws `ConflictError` and leaves that tenant's row as it was, where it used to move the row to the writer. A served store already refused it.
- **A write through a store with an empty `hippoRoot` uses the built-in half-life.** `loadConfig('')` returns the defaults, where it used to read `config.json` from the process's working folder.
- **`remember` through a served store checks the input before it refuses a connector option.** A call that sends `afterWrite` or `untrusted` with invalid input now rejects with the input error; with valid input it is refused with the same message as before.
- **`remember`, `outcome` and `outcomeForLastRecall` each have one implementation.** They run one body on the served store or on hippo.db through `onStore`. Exported names and signatures are unchanged.

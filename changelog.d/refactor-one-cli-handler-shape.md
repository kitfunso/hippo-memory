### Changed

- **Internal:** every CLI verb now enters through one shape, `handle<Verb>(ctx)`, and `cmd<Name>` names only a typed function below an entry. No verb's output, writes or exit codes change.

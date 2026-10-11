### Changed

- **Internal:** every caller of the api write functions (`remember`, `rememberLocally`, `outcome`, `outcomeForLastRecall`, `forget`, `supersede`, `archiveRaw`, `authCreate`, `authCreateSelf`, `authListRows`, `authRevoke`) and of `importVault` now awaits the result, so the later async signatures need no caller changes. Behaviour is unchanged.

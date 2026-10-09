### Fixed

- **The store worker error codec reads thrown-value text through `errorMessage`.** Internal only: it clears the error-text check on master, and the text is unchanged.

### Changed

- **Seventeen long functions in sleep, capture, the GitHub connector, the hooks, the eval harness and the API are split into named steps.** Each was over 50 lines and now reads as load, decide, act, so a reviewer can check one step at a time. Internal only, no behaviour change.

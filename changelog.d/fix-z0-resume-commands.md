### Fixed

- **A Z0 final check after a resume now gets the resume's own commands in `CHECK_RESUME_COMMANDS`.** It used to see only the whole session's list, so a rule about which command to run could never pass a corrected session. The grading save keeps the list as `commandsResume`; the regrade takes it from there, or from the final list past the first one for an older save. A reader pair for a final check now shows the commands before and after the follow-up message.

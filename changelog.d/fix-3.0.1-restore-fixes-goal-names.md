### Fixed

- **`hippo goal push` fails with its usage line on a name of control characters alone, and the log guard drops DEL and the C1 controls.** A name such as a lone ESC used to become a goal named `?`. Goal names now drop control characters instead of storing each as `?`, and DEL and U+0080 to U+009F are dropped from goal names and from the hook and pre-compact logs too, since NEL breaks a line and CSI starts an escape in some terminals.

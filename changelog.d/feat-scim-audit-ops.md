### Added

- **Four audit ops for SCIM user writes: `scim_user_create`, `scim_user_replace`, `scim_user_patch` and `scim_user_delete`.** An add-on that provisions users over SCIM can write them, and `hippo audit list --op` and `GET /v1/audit?op=` accept them. Core writes none of them itself.

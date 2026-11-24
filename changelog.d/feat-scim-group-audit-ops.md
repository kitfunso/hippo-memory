### Added

- **Four audit ops for SCIM group writes: `scim_group_create`, `scim_group_replace`, `scim_group_patch` and `scim_group_delete`.** An add-on that provisions groups over SCIM can write them, and `hippo audit list --op` and `GET /v1/audit?op=` accept them. Core writes none of them itself.

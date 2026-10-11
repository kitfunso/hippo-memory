### Changed

- **Internal:** the LIKE-route switch, the delivery-recorder fault setter and the spool fs setter are gone. The recorder takes `fault` in its init, the spool functions and `runDoctor` take an optional fs, and the LIKE branch is reached by a part-word query.

### Changed

- Internal: reject, unreject and the rejections list no longer open hippo.db from the reject flow; one store module opens it, and each still runs on a single handle and write scope.

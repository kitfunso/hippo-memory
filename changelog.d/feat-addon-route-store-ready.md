### Added

- **An add-on route can name the store group it needs.** `AddonRoute` gains an optional `storeReady`, as core routes have. Under a store other than hippo.db, an add-on route runs when that store has its group and answers 501 `store_not_ported` before its handler when it does not. A route with no `storeReady` still runs on hippo.db only.

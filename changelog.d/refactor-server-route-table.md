### Changed

- **The HTTP server's /v1 routes now live in a route table.** Each of the 62 routes is its own named handler in `src/server.ts`, and `handleRequest` walks the table in the old order. Status codes, headers, bodies and auth order are unchanged; a new parity test pins each route's reply.

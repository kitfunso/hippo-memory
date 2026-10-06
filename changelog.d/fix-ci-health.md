### Fixed

- **The dashboard's 400 for an oversized action body now reaches the client.** Past the 64 KB ceiling the server answered 400 and closed the connection while request bytes were still arriving, and that close sent a TCP reset, which on Windows threw the reply away: an upload that did not pause saw "connection reset" every time. The server now ends its side after the reply, reads and discards the rest for up to 2 seconds, then closes, so the client reads the 400.

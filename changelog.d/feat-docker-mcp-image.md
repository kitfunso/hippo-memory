### Added

- **A Docker image for hippo's MCP server.** `deploy/mcp/Dockerfile` builds hippo from source and runs `hippo mcp` over stdio as the `node` user. The store lives in a volume at `/data` on your own machine, and the image holds no memories. It is the image for the Docker MCP Catalog entry. Try it with `docker build -f deploy/mcp/Dockerfile -t hippo-mcp .` and `docker run -i --rm -v hippo-memory:/data hippo-mcp`.

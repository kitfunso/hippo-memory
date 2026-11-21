# hippo's stdio MCP server for the Docker MCP Catalog. The store lives on a local volume at /data.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no dependency install script runs in the build.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY --from=build /app/bin ./bin
# Docker copies this owner and mode onto a new named volume: node writes it, nobody else reads it.
RUN mkdir /data && chown node:node /data && chmod 700 /data
USER node
ENV HIPPO_HOME=/data
WORKDIR /data
ENTRYPOINT ["node", "/app/bin/hippo.js", "mcp"]

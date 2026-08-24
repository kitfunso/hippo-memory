# AML (agentmemoryleaderboard.ai) evaluation deployment for hippo-memory.
#
# Runs hippo's own HTTP server with bearer auth required. The store lives on a
# persistent volume at /data (the store ROOT is /data/.hippo - the .hippo
# directory IS the root; see deploy/aml/README.md for the layout gotchas).
#
# Embeddings run on the LOCAL provider (@huggingface/transformers) - the
# zero-dependency default hippo ships to every user. This is deliberate for
# the open-source leaderboard category: the deployment benchmarks the system
# as installed, with no external embedding API, and is reproducible by anyone
# from this Dockerfile alone.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the postinstall hook is a dist/ trampoline whose script
# file is not in this layer yet; it no-ops on fresh builds regardless.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build:all

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY --from=build /app/bin ./bin
COPY deploy/aml/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# /data is the Fly volume mount; the hippo store root is /data/.hippo.
WORKDIR /data
ENV HIPPO_REQUIRE_AUTH=1
ENV HIPPO_PORT=8080
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]

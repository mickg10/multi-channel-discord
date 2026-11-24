# Router (Discord bot + agent-bus WebSocket server). Clients are not containerised:
# they run inside each agent (Claude plugin / bin/agent-bus-mcp).
FROM oven/bun:1-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
ENV DISCORD_STATE_DIR=/state \
    DISCORD_WS_HOST=0.0.0.0 \
    DISCORD_WS_PORT=8789
VOLUME /state
EXPOSE 8789
USER bun
CMD ["bun", "src/router.ts"]

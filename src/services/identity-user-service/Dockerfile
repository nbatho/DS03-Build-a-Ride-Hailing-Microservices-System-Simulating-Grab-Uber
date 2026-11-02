FROM node:24-bookworm-slim AS build
WORKDIR /workspace
COPY package*.json ./
RUN npm ci
COPY tsconfig.json nest-cli.json webpack.config.js ./
COPY src ./src
RUN npm run build:identity-user-service && npm run build:identity-migrations

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /workspace/dist/identity-user-service ./dist/identity-user-service
COPY --from=build /workspace/dist/identity-migrations ./dist/identity-migrations
COPY scripts/identity/migrate.cjs ./scripts/identity/migrate.cjs
USER node
EXPOSE 3001
CMD ["node", "dist/identity-user-service/main.js"]

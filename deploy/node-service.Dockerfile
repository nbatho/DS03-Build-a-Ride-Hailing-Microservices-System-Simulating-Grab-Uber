# Dockerfile dùng chung cho một app NestJS trong monorepo (BA mục 9, 13.2).
#   docker build -f deploy/node-service.Dockerfile --build-arg SERVICE=simulated-payment-service --target runtime .
# Stage "migrate" chạy migration TypeORM của service bằng user migrator; stage "runtime" chỉ có bản build + deps chạy.
# Service nào cần khác (ví dụ Identity) thì dùng Dockerfile riêng trong thư mục service.

FROM node:24-bookworm-slim AS build
ARG SERVICE
WORKDIR /workspace
COPY package*.json ./
RUN npm ci
COPY tsconfig.json nest-cli.json webpack.config.js ./
COPY src ./src
RUN test -n "$SERVICE" && npx nest build "$SERVICE"

FROM build AS migrate
ARG SERVICE
ENV SERVICE=${SERVICE}
CMD ["sh", "-c", "exec node -r ts-node/register node_modules/typeorm/cli.js migration:run -d src/services/$SERVICE/src/database/data-source.ts"]

FROM node:24-bookworm-slim AS runtime
ARG SERVICE
ENV NODE_ENV=production HOST=0.0.0.0 SERVICE=${SERVICE}
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /workspace/dist/${SERVICE} ./dist/${SERVICE}
USER node
CMD ["sh", "-c", "exec node dist/$SERVICE/main.js"]

# One image for both services; compose picks the command (worker or server).
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY worker/package.json worker/
COPY web/package.json web/
# devDependencies (typescript, vite) are needed for the build; pruned afterwards.
RUN npm ci --include=dev

COPY schemas schemas
COPY shared shared
COPY server server
COPY worker worker
COPY web web
RUN npm run build && npm prune --omit=dev

USER node
EXPOSE 8443
CMD ["node", "server/dist/main.js"]

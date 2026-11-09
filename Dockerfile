# Self-hosted Freezer Scan. See selfhost/README.md.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY public ./public
COPY netlify/functions ./netlify/functions
COPY netlify/lib ./netlify/lib
COPY selfhost/server.mjs ./server.mjs
# api.mjs imports @netlify/blobs; this file-backed stand-in answers instead.
RUN rm -rf ./node_modules/@netlify/blobs
COPY selfhost/blobs-fs ./node_modules/@netlify/blobs
ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/how.html >/dev/null || exit 1
CMD ["node", "server.mjs"]

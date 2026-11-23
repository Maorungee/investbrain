FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY providers ./providers
COPY public ./public
ENV NODE_ENV=production PORT=3000
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/status || exit 1
CMD ["node", "server.mjs"]

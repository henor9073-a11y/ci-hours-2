FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV PORT=3000
ENV DATA_DIR=/data
EXPOSE 3000

CMD ["node", "server.js"]

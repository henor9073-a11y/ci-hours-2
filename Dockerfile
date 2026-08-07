FROM node:20-slim

# 钓鱼小游戏（games/fishing）是纯 Python、零依赖的，node 镜像本身不带 python3，
# 装一个最小的运行时够用了。
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY games ./games

ENV PORT=3000
ENV DATA_DIR=/data
EXPOSE 3000

CMD ["node", "server.js"]

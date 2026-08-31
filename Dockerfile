# ---------- 阶段1：编译 better-sqlite3 原生模块 ----------
FROM docker.m.daocloud.io/library/node:20-alpine AS builder
WORKDIR /build
RUN apk add --no-cache python3 make g++
COPY ./package.json ./
RUN npm install --omit=dev

# ---------- 阶段2：运行时（不带编译工具，镜像更小更安全） ----------
FROM docker.m.daocloud.io/library/node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

# 后端代码 + 依赖
COPY --from=builder /build/node_modules ./backend/node_modules
COPY file/server.js file/package.json ./backend/

# 前端页面
COPY file/index.html ./html/

# 数据目录（运行时用 volume 挂载持久化）
RUN mkdir -p ./backend/data

EXPOSE 3000
CMD ["node", "backend/server.js"]

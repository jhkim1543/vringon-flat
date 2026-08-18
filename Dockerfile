# VRINGON FLAT — 제품 사진 → 레이어드 .ai
#
# sharp와 @neplex/vectorizer는 네이티브 바이너리를 쓴다. slim 이미지에서
# 빌드 도구 없이 설치하면 조용히 실패하므로 빌드 단계에서만 설치한다.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY server ./server
COPY web ./web
COPY docs ./docs
# 산출물은 볼륨으로 빼는 것을 권장 — 계속 쌓인다
RUN mkdir -p outputs
EXPOSE 5201
# tsx는 devDependency이므로 런타임에 받아 쓴다 (이미지 크기 대신 단순함을 택함)
RUN npm i -g tsx@4
CMD ["tsx", "server/index.ts"]

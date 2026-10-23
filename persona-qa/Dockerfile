# 웹 화면(server.mjs) 배포용 이미지. Chromium, 한글 글꼴, Claude Code CLI를 함께 설치한다.
FROM node:20-bookworm-slim

# fonts-noto-cjk: 없으면 스크린샷의 한글이 네모로 보여서 페르소나가 화면을 읽지 못한다.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-cjk ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p results

ENV NODE_ENV=production \
    PERSONA_QA_BROWSER=/usr/bin/chromium \
    DISABLE_AUTOUPDATER=1
EXPOSE 3000
CMD ["node", "server.mjs"]

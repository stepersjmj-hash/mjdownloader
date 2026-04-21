# Reelsnap — Synology NAS / Docker 용 이미지
#
# 특징:
#   - Node.js + Python3(yt-dlp zipapp 실행용)
#   - 비루트 사용자로 실행 (보안)
#   - 컨테이너 헬스체크 포함
#
# 빌드:
#   docker build -t reelsnap:latest .
#
# 실행:
#   docker run -d --name reelsnap -p 3100:3000 --restart unless-stopped reelsnap:latest
#
# docker compose 사용 시:
#   docker compose up -d --build

FROM node:20-slim

# yt-dlp zipapp 실행용 python3 + CA 인증서
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# package.json + postinstall 스크립트 먼저 복사 → yt-dlp 다운로드
# (package.json 의 postinstall 훅이 scripts/install-ytdlp.js 를 실행함)
COPY package.json ./
COPY scripts ./scripts
RUN npm install --omit=dev

# 앱 소스 복사
COPY server.js index.html style.css app.js ./

# 비루트 사용자 생성 + 권한
RUN groupadd -r reelsnap && useradd -r -g reelsnap reelsnap && \
    chown -R reelsnap:reelsnap /app
USER reelsnap

# 내부 포트 (호스트에서는 compose 의 ports 매핑 참고)
EXPOSE 3000

# 컨테이너 헬스체크 (30초마다 /msec 핑)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/msec',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]

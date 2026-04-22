# Reelsnap — Synology NAS / Docker 용 이미지 (경량, 빌드 네트워크 불필요)
#
# 빌드 전 준비:
#   프로젝트 루트에 'yt-dlp' (Linux 바이너리) 를 미리 넣어둘 것.
#   다운로드: https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
#   → 파일명을 'yt-dlp' 로 변경 후 프로젝트 루트에 저장
#
# 빌드 / 실행:
#   docker compose up -d --build

FROM node:20-slim

WORKDIR /app

# 소스 + yt-dlp 바이너리 통째로 복사 (빌드 중 네트워크 불필요)
COPY . /app

# yt-dlp 실행 권한 + 비루트 사용자
RUN chmod +x /app/yt-dlp && \
    groupadd -r reelsnap && useradd -r -g reelsnap reelsnap && \
    chown -R reelsnap:reelsnap /app

USER reelsnap

# 내부 포트 (호스트에서는 compose 의 ports 매핑 참고)
EXPOSE 3000

# 컨테이너 헬스체크 (30초마다 /msec 핑)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/msec',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]

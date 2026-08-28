# Reelsnap — Synology NAS / Docker 용 이미지 (경량, 빌드 네트워크 불필요)
#
# 빌드 전 준비:
#   1) yt-dlp (Linux 바이너리) 를 프로젝트 루트에 배치  ★재배포 때마다 최신으로 교체★
#      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
#      → 파일명을 'yt-dlp' 로 변경
#      (YouTube 는 추출 방식이 자주 바뀌어서 구버전 yt-dlp 는 곧 전부 실패한다)
#   2) ffmpeg (Linux static 바이너리) 를 프로젝트 루트에 배치
#      https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
#      → 압축 해제 후 'ffmpeg' 실행파일만 프로젝트 루트로 복사
#      (YouTube 720p+ 머지 및 HEVC → AVC 자동 변환에 필요 — 배치 권장)
#
# 빌드 / 실행:
#   docker compose up -d --build

# Node 24 필수 — yt-dlp 가 YouTube JS 챌린지를 풀 때 `node --permission` 을 쓰는데
# 이 플래그가 정식으로 들어간 것이 Node 24 다. Node 20/22 로 내리면 YouTube 가 전부 실패한다.
FROM node:24-slim

WORKDIR /app

# 소스 + yt-dlp 바이너리 통째로 복사 (빌드 중 네트워크 불필요)
COPY . /app

# yt-dlp + ffmpeg 실행 권한 + 비루트 사용자
# (ffmpeg 이 없으면 chmod 가 오류를 내지만 빌드는 계속 — YouTube 720p+ / HEVC 변환 불가)
RUN chmod +x /app/yt-dlp && \
    ([ -f /app/ffmpeg ] && chmod +x /app/ffmpeg || echo "[build] ffmpeg 없음 — YouTube 720p+ 불가") && \
    groupadd -r reelsnap && useradd -r -g reelsnap reelsnap && \
    chown -R reelsnap:reelsnap /app

USER reelsnap

# 내부 포트 (호스트에서는 compose 의 ports 매핑 참고)
EXPOSE 3000

# 컨테이너 헬스체크 (30초마다 /msec 핑) — PORT 환경변수 존중
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/msec',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]

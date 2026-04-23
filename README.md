# Reelsnap

인스타그램 릴스 및 게시물(이미지 포함)을 브라우저에서 바로 다운로드하는 웹 서비스. yt-dlp 기반 프록시 서버를 경유해 인스타그램 CDN의 IP 잠금 이슈를 우회합니다.

## 접속 URL

| 환경 | URL | 용도 |
|---|---|---|
| NAS (주 서버) | https://stepersjmj.synology.me:8443/ | 메인 서비스 — 빠름, 일괄 다운로드 안정적 |
| Render (백업) | https://mjdownloader-fo5w.onrender.com/ | NAS 점검 시 폴백, 자동 배포 |
| GitHub Pages | https://stepersjmj-hash.github.io/mjdownloader/ | 정적 프론트 — API는 Render 호출 |

## 기술 스택

- **프론트엔드**: HTML + Vanilla JavaScript + CSS (프레임워크 없음)
- **백엔드**: Node.js (내장 `http` 모듈만 사용, 외부 의존성 0개)
- **미디어 추출**: [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- **배포**: Render (자동) + Synology NAS Docker (수동)

## 프로젝트 구조

```
.
├── server.js                 # Node.js HTTP 서버 (백엔드 API + 정적 파일 서빙)
├── index.html                # 프론트엔드 페이지
├── app.js                    # 프론트엔드 로직 (백엔드 분기 포함)
├── style.css                 # 스타일
├── package.json              # postinstall 훅으로 yt-dlp 다운로드
├── scripts/
│   └── install-ytdlp.js      # yt-dlp 자동 설치 (Render 빌드용)
├── render.yaml               # Render 배포 설정
├── Dockerfile                # NAS Docker 이미지 (빌드 네트워크 불필요)
├── docker-compose.yml        # NAS 컨테이너 설정 (host 네트워크 모드)
├── .dockerignore
├── .gitignore
├── NAS_DEPLOYMENT.md         # NAS 배포 상세 가이드
└── README.md
```

## 사용 방법

1. 인스타그램에서 릴스/게시물 링크 복사
2. 접속 URL 중 하나 접속 → 입력창에 URL 붙여넣기
3. **다운로드** 버튼 클릭 → 썸네일 + 화질 옵션 표시됨
4. 항목의 **⬇ 다운로드** 버튼 클릭

**일괄 다운로드**: 텍스트를 통째로 붙여넣으면 정규식으로 URL을 자동 추출해 체크박스 목록으로 보여주고, 선택한 것들을 순차 저장합니다.

## 로컬 개발 (Windows)

```powershell
cd C:\Users\stepe\Desktop\mj\mjdownloader
# yt-dlp.exe 를 프로젝트 루트에 배치
# (https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe)
node server.js
# → http://localhost:3000
```

`package.json` 에 외부 의존성이 없어 `npm install` 이 필수는 아닙니다. postinstall 훅은 Windows 환경에서 스킵됩니다 (`scripts/install-ytdlp.js` 참고).

## 배포 방식

### 1. Render (자동 배포)

`render.yaml` 기반으로 GitHub `main` 브랜치에 푸시하면 자동 재배포됩니다. Render가 `npm install` 실행 → postinstall 훅이 Linux용 `yt-dlp` Python zipapp을 자동 다운로드합니다.

**특징 / 한계**
- 무료 플랜: 15분 유휴 후 슬립 → 첫 요청 콜드스타트 30초+
- CPU 0.1코어 공유, 대역폭 제한
- **일괄 다운로드 동시 요청 시 실패 빈번** — NAS 배포의 주된 이유

### 2. GitHub Pages (정적 프론트엔드)

`index.html`, `style.css`, `app.js` 만 호스팅. 백엔드 API는 `app.js` 의 분기 로직에 의해 Render URL로 호출됩니다 (`REMOTE_BACKEND` 상수).

### 3. Synology NAS Docker

별도 문서 **[NAS_DEPLOYMENT.md](./NAS_DEPLOYMENT.md)** 참고. DS920+ 환경에서 검증된 절차입니다.

## 백엔드 분기 로직 (`app.js`)

```js
const REMOTE_BACKEND = 'https://mjdownloader-fo5w.onrender.com';
const host = location.hostname;
const isGitHubPages = host.endsWith('.github.io');
const BACKEND = isGitHubPages ? REMOTE_BACKEND : '';
```

| 접속 호스트 | `BACKEND` 값 | API 호출 대상 |
|---|---|---|
| `localhost` | `''` (상대경로) | 로컬 `server.js` |
| `stepersjmj.synology.me` | `''` (상대경로) | NAS의 `server.js` |
| `mjdownloader-fo5w.onrender.com` | `''` (상대경로) | Render의 `server.js` |
| `stepersjmj-hash.github.io` | `REMOTE_BACKEND` | Render API 원격 호출 |

같은 도메인에서 서빙되는 경우는 CORS 이슈가 없고, GitHub Pages에서만 원격 CORS 호출이 발생합니다. 서버의 `Access-Control-Allow-Origin: *` 헤더로 허용됩니다.

## 트러블슈팅

### "Not Found" 페이지가 뜨면서 브라우저가 다른 곳으로 이동
→ `app.js` 의 `REMOTE_BACKEND` 가 구 Render URL(`mjdownloader-bbm5`) 로 캐시됐을 수 있음. 강제 새로고침(Ctrl+Shift+R) 후 재시도.

### Render에서 다운로드 속도 느림 또는 일괄 다운로드 실패
→ Render 무료 플랜 한계. **NAS URL** (`https://stepersjmj.synology.me:8443/`) 사용 권장.

### 로컬 Windows에서 yt-dlp 실행 실패
→ 프로젝트 루트에 `yt-dlp.exe` 있는지 확인. 없으면 [릴리즈 페이지](https://github.com/yt-dlp/yt-dlp/releases/latest)에서 `yt-dlp.exe` 다운로드.

### NAS 배포 관련 이슈
→ **[NAS_DEPLOYMENT.md](./NAS_DEPLOYMENT.md)** 의 트러블슈팅 섹션 참고 (Docker 빌드/실행 DNS 이슈, 방화벽, 리버스 프록시 등).

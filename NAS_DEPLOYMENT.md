# Reelsnap — NAS Docker 배포 가이드

Synology DS920+ (DSM 7.2, Container Manager) 기준 배포 절차. 다른 Synology 모델에도 대부분 동일하게 적용됩니다.

## 왜 NAS 인가?

**Render 무료 플랜의 한계**
- 15분 유휴 후 슬립 → 콜드스타트 30초+
- CPU 0.1코어 공유, 대역폭 제한
- 동시 요청 2~3개 초과 시 연결 끊김 (일괄 다운로드가 망가지는 근본 원인)

**NAS 전환 효과 (DS920+ / J4125 쿼드코어)**
- 슬립 없음, 콜드스타트 없음
- 전용 CPU + 집 인터넷 대역폭 전부 활용
- 일괄 다운로드 10개+ 동시 처리 여유

**단점**: 설정 복잡도 증가, 집 인터넷 업로드 속도가 외부 접속 시의 천장.

## 전제 조건

- Synology DSM 7.2 이상 + **Container Manager** 패키지 설치
- Synology DDNS (`xxx.synology.me`) 등록 + Let's Encrypt 인증서 발급 완료
- 공유기에서 HTTPS용 포트포워딩 이미 설정됨 (이 가이드는 `8443` 추가 필요)

## 핵심 설계 결정 (왜 이렇게 만들었는지)

### 1) `network_mode: host` 사용

일반 Docker bridge 네트워크에서 **컨테이너의 외부 DNS 해석이 실패**합니다. Synology Container Manager가 `dns:` compose 옵션을 무시하는 이슈 때문. 호스트 네트워크 모드로 전환해 NAS 네트워크 스택을 직접 사용하여 우회.

### 2) `yt-dlp_linux` 바이너리 수동 배치

DS920+ Container Manager는 **Docker 빌드 중 외부 네트워크도 제한**됩니다 (`apt-get update` 시 `deb.debian.org` 해석 실패). 이를 우회하려고:
- 빌드 중 네트워크 요청을 전부 배제 (`Dockerfile` 에 `apt-get`, `npm install` 없음)
- yt-dlp 바이너리를 로컬에서 미리 다운로드 후 이미지에 `COPY`
- `yt-dlp_linux` (PyInstaller 번들) 사용으로 Python 설치 불필요

이 두 가지가 설계의 핵심입니다.

## 설치 절차

### 1. yt-dlp Linux 바이너리 다운로드

Windows 브라우저로 접속:
```
https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
```

파일명을 **`yt-dlp`** (확장자 없음) 로 변경. 탐색기에서 확장자 표시를 켜두고 `.txt` 등이 붙지 않도록 확인.

### 2. NAS에 소스 파일 업로드

Windows 탐색기에서 `\\NAS내부IP\docker` 접속 → `reelsnap` 폴더 생성 → 아래 파일 복사:

```
reelsnap/
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── package.json
├── server.js
├── index.html
├── app.js
├── style.css
├── yt-dlp                    ← 1단계에서 다운받은 Linux 바이너리
└── scripts/
    └── install-ytdlp.js
```

`.git`, `node_modules`, `yt-dlp.exe` 는 NAS에 올릴 필요 없음.

### 3. Container Manager에서 프로젝트 생성

1. **Container Manager → 프로젝트 → 생성**
2. 프로젝트 이름: `mjdownloader` (자유)
3. 경로: `/docker/reelsnap`
4. 원본: **docker-compose.yml 만들기** 선택
5. YAML 편집창에 아래 내용 붙여넣기:

```yaml
services:
  reelsnap:
    build: .
    container_name: reelsnap
    # Synology Container Manager 의 dns: 무시 이슈 우회.
    # 호스트 네트워크 모드로 NAS DNS/라우팅을 그대로 사용.
    network_mode: host
    restart: unless-stopped
    environment:
      - PORT=3100
```

6. 웹 포털 설정 **건너뛰기**
7. **완료** → 자동 빌드 + 실행 (첫 빌드 ~30초)

### 4. 동작 확인

**Container Manager → 컨테이너 → `reelsnap`** 상태 "실행 중" 확인.

컨테이너 더블클릭 → **터미널 → 생성 → `bash`** 입력 후:

```bash
# 1. DNS 설정 확인 (127.0.0.11 이면 host 모드 미적용)
cat /etc/resolv.conf

# 2. 인스타그램 도메인 해석 테스트
node -e "require('dns').lookup('www.instagram.com',(e,a)=>console.log(e||a))"
# → IP 주소 출력되면 정상

# 3. 서버 응답 테스트
node -e "require('http').get('http://127.0.0.1:3100/msec',r=>r.pipe(process.stdout))"
# → {"msec":...} JSON 출력되면 정상
```

**LAN에서 브라우저 접속**: `http://NAS내부IP:3100` → Reelsnap 페이지 뜨면 성공.

### 5. Synology 방화벽 규칙 추가 (필요시)

LAN 접속이 타임아웃이면:

**DSM 제어판 → 보안 → 방화벽 → 규칙 편집 → 생성**
- 포트: **사용자 지정 → TCP 3100**
- 소스 IP: 모두 (또는 LAN 서브넷)
- 동작: **허용**
- 규칙을 거부 규칙보다 **위로 드래그**

## 외부 접속 설정

### 1. 리버스 프록시 규칙 추가

**DSM 제어판 → 로그인 포털 → 고급 탭 → 리버스 프록시 → 생성**

```
설명: Reelsnap

[소스]
프로토콜: HTTPS
호스트명: stepersjmj.synology.me
포트:    8443
HSTS 활성화: 체크

[대상]
프로토콜: HTTP
호스트명: localhost
포트:    3100
```

**사용자 정의 헤더 탭 → 생성 → WebSocket** 선택해 Upgrade/Connection 헤더 자동 추가.

**저장**.

### 2. 인증서 재사용

Synology DDNS는 계정당 호스트명 1개만 허용. 서브도메인(`reelsnap.xxx.synology.me`) 대신 **같은 도메인의 다른 포트(`:8443`)** 로 분리했기 때문에 기존 `stepersjmj.synology.me` 인증서를 그대로 씁니다.

**제어판 → 보안 → 인증서** → 기존 `stepersjmj.synology.me` 인증서 선택 → **설정** → 새 리버스 프록시 항목이 이 인증서를 쓰도록 지정.

### 3. 공유기 포트포워딩

기존 443 포트포워딩과 **별개로** 8443 포트 추가:
```
외부 포트: 8443 → 내부 IP: NAS내부IP / 내부 포트: 8443 / TCP
```

공유기 관리 페이지 접속은 ISP별로 다름 (예: KT `http://172.30.1.254`).

### 4. 외부 접속 테스트

```
https://stepersjmj.synology.me:8443/
```

LTE/5G 등 집 외부 망에서 접속해서 Reelsnap 페이지가 뜨고 다운로드가 동작하는지 확인.

## 업데이트 방법

### 소스 코드 변경 반영

1. Windows에서 Git commit & push
2. NAS `/docker/reelsnap/` 폴더에 변경된 파일 덮어쓰기 (SMB 또는 File Station)
3. **Container Manager → 프로젝트 → mjdownloader → 빌드** 클릭 → 이미지 재생성 + 컨테이너 재시작

### yt-dlp 버전 업데이트

yt-dlp는 이미지에 내장되어 있으므로:
1. [최신 `yt-dlp_linux` 다운로드](https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux)
2. 파일명을 `yt-dlp` 로 변경
3. NAS `/docker/reelsnap/yt-dlp` 덮어쓰기
4. Container Manager에서 **빌드** 재실행

## 트러블슈팅

### 빌드 실패: `Temporary failure resolving 'deb.debian.org'`
Synology Container Manager 빌드 네트워크 DNS 이슈. 현재 `Dockerfile` 은 빌드 중 네트워크 요청을 하지 않도록 설계돼 있어 이 에러는 나오면 안 됨. 만약 발생했다면 **구 버전 Dockerfile**이 쓰이고 있는 것 — 최신 `Dockerfile` 로 교체.

### 빌드 실패: `chmod: cannot access '/app/yt-dlp'`
프로젝트 루트에 `yt-dlp` Linux 바이너리가 없어서 발생. 1단계(바이너리 다운로드) 수행 후 `/docker/reelsnap/yt-dlp` 경로에 파일 있는지 확인.

### 실행 중 DNS 에러: `EAI_AGAIN` / `Temporary failure in name resolution`
Docker bridge 네트워크에서 외부 DNS 실패. `network_mode: host` 가 제대로 적용됐는지 확인:
```bash
sudo docker inspect reelsnap | grep NetworkMode
# → "NetworkMode": "host" 여야 정상
```
`bridge` 로 나오면 YAML이 구버전 — 수정 후 **컨테이너 삭제 → 재생성** (단순 재시작은 반영 안 됨).

### LAN 접속 불가 (ERR_CONNECTION_TIMED_OUT)
1. 컨테이너 상태 "실행 중" 확인
2. 컨테이너 내부에서 `node -e "require('http').get('http://127.0.0.1:3100/msec',r=>r.pipe(process.stdout))"` 실행 → JSON 응답 오면 서버는 정상
3. 이 경우 **Synology 방화벽에서 3100 포트 허용** 누락. 설치 절차 5단계 참고.

### Let's Encrypt 인증서 발급 시 "이 도메인 이름의 유효성을 검사할 수 없습니다"
Synology DDNS는 계정당 하나의 호스트명만 등록 가능. 서브도메인(`reelsnap.xxx.synology.me`) 이 자동 등록되지 않아 검증 실패. **포트 분리 방식**(`xxx.synology.me:8443`) 사용 → 기존 인증서 재사용으로 해결.

### 일괄 다운로드가 여전히 실패하면
NAS URL이 아니라 Render URL로 접속하고 있을 가능성. URL이 `https://stepersjmj.synology.me:8443/` 인지 확인. 브라우저 북마크가 구 URL을 가리키고 있을 수도 있음.

## 참고 링크

- [yt-dlp 릴리즈 페이지](https://github.com/yt-dlp/yt-dlp/releases/latest)
- [Synology Container Manager 공식 문서](https://kb.synology.com/en-global/DSM/help/ContainerManager/docker_desc)
- [Docker Compose 레퍼런스 (네트워크 모드)](https://docs.docker.com/compose/compose-file/compose-file-v3/#network_mode)

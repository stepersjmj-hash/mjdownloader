/**
 * yt-dlp 자동 설치 스크립트 (postinstall)
 * - Windows: yt-dlp.exe 가 있으면 스킵
 * - Linux(Render): yt-dlp 바이너리를 프로젝트 루트에 다운로드
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const IS_WIN  = process.platform === 'win32';
const EXE     = path.join(ROOT, 'yt-dlp.exe');
const BIN     = path.join(ROOT, 'yt-dlp');
const DL_URL  = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

// Windows: .exe 있으면 스킵
if (IS_WIN) {
  if (fs.existsSync(EXE)) {
    console.log('[install-ytdlp] Windows: yt-dlp.exe 이미 존재, 스킵');
  } else {
    console.log('[install-ytdlp] Windows: yt-dlp.exe 를 수동으로 넣어주세요.');
  }
  process.exit(0);
}

// Linux: 이미 있으면 스킵
if (fs.existsSync(BIN)) {
  console.log('[install-ytdlp] yt-dlp 이미 존재:', BIN);
  process.exit(0);
}

// Linux: 다운로드
console.log('[install-ytdlp] yt-dlp 다운로드 중...');
console.log('[install-ytdlp] URL:', DL_URL);

const file = fs.createWriteStream(BIN);

function download(url, dest, cb) {
  https.get(url, (res) => {
    // 리다이렉트 처리
    if (res.statusCode === 301 || res.statusCode === 302) {
      console.log('[install-ytdlp] 리다이렉트 →', res.headers.location);
      return download(res.headers.location, dest, cb);
    }
    if (res.statusCode !== 200) {
      return cb(new Error('HTTP ' + res.statusCode));
    }
    res.pipe(dest);
    dest.on('finish', () => dest.close(cb));
  }).on('error', (e) => {
    fs.unlink(dest.path, () => {});
    cb(e);
  });
}

download(DL_URL, file, (err) => {
  if (err) {
    console.error('[install-ytdlp] 다운로드 실패:', err.message);
    process.exit(1);
  }
  // 실행 권한 부여
  fs.chmodSync(BIN, 0o755);
  console.log('[install-ytdlp] ✅ 설치 완료:', BIN);

  // 버전 확인
  try {
    const v = execSync(`"${BIN}" --version`).toString().trim();
    console.log('[install-ytdlp] 버전:', v);
  } catch (e) {
    console.warn('[install-ytdlp] 버전 확인 실패:', e.message);
  }
});

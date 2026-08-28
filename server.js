/**
 * Reelsnap 백엔드 — yt-dlp 기반 프록시 서버 (Instagram + YouTube)
 * 로컬 실행: node server.js  →  http://localhost:3000
 * Render 배포: render.yaml 참고
 * NAS 배포: NAS_DEPLOYMENT.md 참고
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawn } = require('child_process');

// Render는 PORT 환경변수를 주입함
const PORT = process.env.PORT || 3000;

// ─── 메타데이터 캐시 (5분 TTL) ────────────────────────────
const metaCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
function getCached(igurl) {
  const entry = metaCache.get(igurl);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { metaCache.delete(igurl); return null; }
  return entry.data;
}
function setCache(igurl, data) { metaCache.set(igurl, { data, ts: Date.now() }); }

// ─── yt-dlp 경로 결정 ────────────────────────────────────
// Windows: 폴더 내 yt-dlp.exe 우선
// Linux(Render): pip 설치된 yt-dlp (시스템 PATH)
const IS_WIN    = process.platform === 'win32';
const LOCAL_EXE = path.join(__dirname, 'yt-dlp.exe');
const LOCAL_BIN = path.join(__dirname, 'yt-dlp');

let YT_DLP_BIN;
if (IS_WIN && fs.existsSync(LOCAL_EXE)) {
  // Windows: 폴더 내 .exe
  YT_DLP_BIN = LOCAL_EXE;
} else if (!IS_WIN && fs.existsSync(LOCAL_BIN)) {
  // Linux: curl로 받은 폴더 내 바이너리 (Render 빌드)
  YT_DLP_BIN = LOCAL_BIN;
} else {
  // 시스템 PATH 폴백
  YT_DLP_BIN = 'yt-dlp';
}
console.log(`[yt-dlp] 경로: ${YT_DLP_BIN} (platform: ${process.platform})`);

// ─── ffmpeg 경로 결정 ────────────────────────────────────
// YouTube 1080p+ 같은 분리형 포맷 merge 시 필요. Instagram에는 불필요.
// Windows: ffmpeg.exe, Linux: ffmpeg (프로젝트 루트)
const FFMPEG_WIN = path.join(__dirname, 'ffmpeg.exe');
const FFMPEG_BIN = path.join(__dirname, 'ffmpeg');
let FFMPEG_PATH = null;
if (IS_WIN && fs.existsSync(FFMPEG_WIN)) {
  FFMPEG_PATH = FFMPEG_WIN;
} else if (!IS_WIN && fs.existsSync(FFMPEG_BIN)) {
  FFMPEG_PATH = FFMPEG_BIN;
}
console.log(`[ffmpeg] 경로: ${FFMPEG_PATH || '(없음 — YouTube 720p+ 불가)'}`);

// ─── YouTube JS 챌린지용 JS 런타임 ───────────────────────
// 최근 yt-dlp 는 YouTube 서명(nsig) 해제를 위해 외부 JS 런타임이 필요하다.
// 기본 활성 런타임은 deno 뿐이라, deno 가 없는 서버(NAS/Render 컨테이너)에서는
// 모든 YouTube 요청이 "This video is not available" 로 즉시 실패한다.
//   → --js-runtimes 로 deno + node 를 함께 허용해 컨테이너의 node 로도 풀게 한다.
//     (node 로 풀 때 yt-dlp 가 `node --permission` 을 쓰므로 Node 24 이상 필요)
// 구버전 yt-dlp 에는 이 옵션 자체가 없어서, 시작 시 --help 로 지원 여부를 1회 검사한다.
const JS_RUNTIMES = 'deno,node';
let JS_RUNTIMES_SUPPORTED = false;

function detectJsRuntimesOption() {
  return new Promise((resolve) => {
    const child = spawn(YT_DLP_BIN, ['--help']);
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(out.includes('--js-runtimes')));
  });
}

// 실행파일 버전 확인 (없으면 null) — /health 진단용
function probeBin(bin, args) {
  return new Promise((resolve) => {
    let out = '', done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try { child = spawn(bin, args); } catch { return finish(null); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, 5000);
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0 ? out.trim() : null); });
  });
}

// YouTube 믹스/재생목록 링크(?list=RD... 등) 는 재생목록 전체를 먼저 훑어서 느리고
// 실패 여지가 크다. 단일 영상만 받도록 --no-playlist 를 붙인다.
function isYoutubePlaylistUrl(url) {
  if (!url) return false;
  if (!/youtube\.com|youtu\.be/.test(url)) return false;
  return /[?&]list=/.test(url);
}

// 모든 yt-dlp 호출에 공통으로 붙는 인자
function commonYtDlpArgs(url) {
  const args = [];
  if (JS_RUNTIMES_SUPPORTED) args.push('--js-runtimes', JS_RUNTIMES);
  if (FFMPEG_PATH)           args.push('--ffmpeg-location', FFMPEG_PATH);
  if (isYoutubePlaylistUrl(url)) args.push('--no-playlist');
  return args;
}

// ─── 지원 플랫폼 ──────────────────────────────────────────
const SUPPORTED_HOSTS = [
  'instagram.com',
  'youtube.com',
  'youtu.be',
  'm.youtube.com',
  'tiktok.com',
  'vm.tiktok.com',
  'vt.tiktok.com',
];
function isSupportedUrl(url) {
  if (!url) return false;
  return SUPPORTED_HOSTS.some(h => url.includes(h));
}

// Instagram /reels/ (복수) → /reel/ (단수) 정규화
// 일부 yt-dlp 버전은 복수형 경로를 인식하지 못하므로 사전 치환
function normalizeIgUrl(url) {
  if (!url) return url;
  return url.replace(/(instagram\.com\/)reels\//i, '$1reel/');
}

// ─── AVC(H.264) 우선 포맷 선택 ───────────────────────────
// HEVC(H.265)는 Windows 브라우저 대부분에서 재생 불가.
// 같은 게시물에 AVC 포맷이 있으면 변환 없이 그것을 우선 선택한다.
// (vcodec 표기가 사이트마다 다름: Instagram 'avc1...', TikTok 'h264' — 두 표기 모두 필터)
const FMT_BEST_AVC  = 'best[ext=mp4][vcodec^=avc][acodec!=none]/best[ext=mp4][vcodec^=h264][acodec!=none]/best[ext=mp4][vcodec!=none][acodec!=none]/best[ext=mp4]/best';
const FMT_WORST_AVC = 'worst[ext=mp4][vcodec^=avc][acodec!=none]/worst[ext=mp4][vcodec^=h264][acodec!=none]/worst[ext=mp4][vcodec!=none][acodec!=none]/worst[ext=mp4]/worst';

function isAvc(vcodec) {
  const v = (vcodec || '').toLowerCase();
  return v.startsWith('avc') || v.startsWith('h264');
}

const HEVC_NAMES = new Set(['hevc', 'h265', 'hvc1', 'hev1', 'x265']);

function checkYtDlp() {
  return new Promise((resolve) => {
    const child = spawn(YT_DLP_BIN, ['--version']);
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.trim() : null));
  });
}

// URL 파싱 헬퍼 (WHATWG URL API 사용 — url.parse 경고 제거)
function parseUrl(reqUrl) {
  return new URL(reqUrl, `http://localhost:${PORT}`);
}

// ─── 메타데이터 추출 ──────────────────────────────────────
function getMediaInfo(instagramUrl) {
  instagramUrl = normalizeIgUrl(instagramUrl);
  return new Promise((resolve, reject) => {
    // 셸을 거치지 않도록 spawn + 인자 배열 사용 (명령어 인젝션 차단)
    const args = ['--dump-json', '--no-warnings', ...commonYtDlpArgs(instagramUrl)];
    args.push(instagramUrl);
    console.log('[yt-dlp] 메타데이터 조회:', instagramUrl);

    const child = spawn(YT_DLP_BIN, args);
    let stdout = '', stderr = '';
    let settled = false;

    // exec 의 timeout:30000 동작 보존
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error('yt-dlp 응답 시간 초과 (30초)'));
    }, 30000);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(e.message));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `yt-dlp 종료코드 ${code}`));

      try {
        const lines = stdout.trim().split('\n').filter(Boolean);
        const items = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        if (!items.length) return reject(new Error('미디어 정보를 가져오지 못했습니다.'));

        const links = [];
        const thumbnail = items[0].thumbnail || null;

        items.forEach((item, i) => {
          const idx   = i + 1;
          const ext   = (item.ext || 'mp4').toLowerCase();
          const isImg = ['jpg','jpeg','png','webp','gif'].includes(ext);
          const type  = isImg ? 'image' : 'video';

          const itemThumb = (() => {
            if (item.thumbnails && item.thumbnails.length) {
              const sorted = [...item.thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
              return sorted[0].url || null;
            }
            return item.thumbnail || null;
          })();

          if (isImg && item.url) {
            links.push({ url: item.url, quality: 'Original', type, index: idx, igurl: instagramUrl, thumbnail: itemThumb });
          } else if (item.formats && item.formats.length > 0) {
            // 영상+음성이 이미 합쳐진(muxed) 포맷만 선택 — ffmpeg 없이 재생 가능
            const vf = item.formats.filter(f =>
              f.vcodec && f.vcodec !== 'none' &&
              f.acodec && f.acodec !== 'none'
            );
            // 같은 해상도에 AVC/HEVC가 모두 있으면 AVC(H.264) 우선 — 변환 없이 호환 확보
            const byHeight = new Map();
            vf.forEach(f => {
              const key = f.height || 0;
              const cur = byHeight.get(key);
              if (!cur || (isAvc(f.vcodec) && !isAvc(cur.vcodec))) byHeight.set(key, f);
            });
            const chosen = [...byHeight.values()].sort((a, b) => (b.height || 0) - (a.height || 0));
            chosen.forEach(f => {
              const q = f.height ? `${f.height}p` : (f.format_note || 'HD');
              links.push({ quality: q, type: 'video', index: idx, igurl: instagramUrl, fmtId: f.format_id, vcodec: f.vcodec || null, thumbnail: itemThumb });
            });
            if (!chosen.length) {
              // muxed 포맷이 없으면 yt-dlp가 자체 선택하도록 AVC 우선 포맷 문자열 사용
              links.push({ quality: 'HD', type: 'video', index: idx, igurl: instagramUrl, fmtId: FMT_BEST_AVC, thumbnail: itemThumb });
            }
          } else {
            links.push({ quality: 'HD', type: 'video', index: idx, igurl: instagramUrl, fmtId: FMT_BEST_AVC, thumbnail: itemThumb });
          }
        });

        if (!links.length) return reject(new Error('다운로드 가능한 미디어를 찾지 못했습니다.'));
        resolve({ success: true, links, thumbnail });
      } catch (e) {
        reject(new Error('파싱 오류: ' + e.message));
      }
    });
  });
}

// ─── yt-dlp 스트리밍 ──────────────────────────────────────
// temp 파일 경유 대상:
//   1) merge 필요 포맷(YouTube 720p+ 의 bv+ba) — stdout 파이핑 시 moov atom 문제
//   2) AVC 여부가 불확실한 mp4 — 코덱 검사 후 HEVC 면 AVC 자동 변환
// vc 파라미터로 AVC 가 확정된 mp4 와 오디오(m4a 등)는 stdout 파이핑 유지.

function isMergeFormat(fmt) {
  // yt-dlp 포맷 문자열의 '+' 가 분리 스트림 merge 를 의미
  // URL 인코딩된 경우 %2B 도 포함되어 있을 수 있음
  return fmt.includes('+') || fmt.toLowerCase().includes('%2b');
}

function handleStream(req, res) {
  const qs         = parseUrl(req.url).searchParams;
  const igurl      = normalizeIgUrl(qs.get('igurl'));
  const idx        = parseInt(qs.get('idx') || '1', 10);
  const fmt        = qs.get('fmt') || FMT_BEST_AVC;
  const ext        = qs.get('ext') || 'mp4';   // mp4(기본) / m4a(오디오) 등
  const vc         = qs.get('vc')  || '';      // 메타데이터에서 확인된 vcodec (AVC 확정이면 직접 스트리밍)
  const fnPrefix   = qs.get('fn')  || 'download';
  const isDownload = qs.get('dl')  === '1';

  if (!igurl) { res.writeHead(400); res.end('igurl 파라미터 필요'); return; }

  // merge 필요, 또는 AVC 확신이 없는 mp4 → temp 파일 방식 (HEVC면 ffmpeg 변환)
  if (ext === 'mp4' && (isMergeFormat(fmt) || !isAvc(vc))) {
    return handleStreamTempFile(req, res, { igurl, idx, fmt, ext, fnPrefix, isDownload });
  }

  console.log(`[stream] idx=${idx} fmt=${fmt} ext=${ext} ${igurl}`);

  const args = ['--playlist-items', String(idx), '--format', fmt, '--no-warnings'];
  if (ext === 'mp4')  args.push('--merge-output-format', 'mp4');
  args.push(...commonYtDlpArgs(igurl));
  args.push('-o', '-', igurl);

  const child = spawn(YT_DLP_BIN, args);
  let headerSent = false;

  child.stdout.once('data', () => {
    if (headerSent) return;
    headerSent = true;
    const contentType = ext === 'm4a' ? 'audio/mp4'
                      : ext === 'mp3' ? 'audio/mpeg'
                      : 'video/mp4';
    const headers = {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    };
    if (isDownload) headers['Content-Disposition'] = `attachment; filename="${fnPrefix}_${idx}.${ext}"`;
    res.writeHead(200, headers);
  });

  // pipe 의 자동 end 를 끄고 직접 마무리한다.
  // (자동 end 로 두면 yt-dlp 가 한 바이트도 못 내고 죽어도 응답이 200 + 0바이트로 끝나서,
  //  브라우저에 빈 파일이 저장되고 실패 원인이 드러나지 않는다.)
  let exitCode = null, stdoutEnded = false;
  function finishStream() {
    if (exitCode === null || !stdoutEnded) return;
    if (res.writableEnded) return;
    if (headerSent) {
      // 이미 헤더/데이터를 보낸 뒤라 500 을 줄 수 없다.
      // 실패했으면 그냥 end() 하지 말고 연결을 끊어야 브라우저가 '실패'로 처리한다
      // (end() 로 닫으면 잘린 파일이 정상 완료된 것처럼 저장됨).
      if (exitCode !== 0) res.destroy(); else res.end();
      return;
    }
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(exitCode === 0 ? 'yt-dlp 가 빈 결과를 반환했습니다.' : 'yt-dlp 다운로드 실패');
  }

  child.stdout.pipe(res, { end: false });
  child.stdout.on('end', () => { stdoutEnded = true; finishStream(); });
  child.stderr.on('data', d => { const m = d.toString().trim(); if (m) console.log('[yt-dlp]', m); });
  child.on('error', (e) => {
    if (!headerSent && !res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(e.message); }
  });
  child.on('close', (code) => { exitCode = code; finishStream(); });
  req.on('close', () => child.kill());
}

// ─── HEVC → AVC 자동 변환 헬퍼 ───────────────────────────
// ffprobe 가 없는 환경 대응: ffmpeg -i 의 stderr 에서 비디오 코덱명 추출
function probeVideoCodec(filePath) {
  return new Promise((resolve) => {
    if (!FFMPEG_PATH) return resolve(null);
    const child = spawn(FFMPEG_PATH, ['-hide_banner', '-i', filePath]);
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const m = err.match(/Video:\s*([A-Za-z0-9_]+)/);
      resolve(m ? m[1].toLowerCase() : null);
    });
  });
}

// 동시 변환 제한 — 일괄 다운로드 시 변환 폭주로 NAS CPU 가 마비되는 것 방지.
// 슬롯이 다 차면 대기 후 순차 실행 (각 변환이 CPU 를 충분히 써서 빨리 끝나도록).
const MAX_CONCURRENT_TRANSCODES = 2;
let activeTranscodes = 0;
const transcodeWaiters = [];
function acquireTranscodeSlot() {
  if (activeTranscodes < MAX_CONCURRENT_TRANSCODES) {
    activeTranscodes++;
    return Promise.resolve();
  }
  return new Promise(resolve => transcodeWaiters.push(resolve));
}
function releaseTranscodeSlot() {
  const next = transcodeWaiters.shift();
  if (next) next();          // 대기자에게 슬롯 승계 (activeTranscodes 유지)
  else activeTranscodes--;
}

// HEVC → H.264 재인코딩 (오디오는 복사). CPU 부하 큼 — HEVC 감지 시에만 호출.
function transcodeToAvc(inPath, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', inPath,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p',   // 10bit/HDR HEVC 소스도 브라우저 호환 8bit 로 강제
      '-c:a', 'copy',
      '-movflags', '+faststart',
      outPath,
    ];
    const child = spawn(FFMPEG_PATH, args);
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `ffmpeg 종료코드 ${code}`));
    });
  });
}

// ─── yt-dlp 스트리밍 (temp 파일 방식) ─────────────────────
// merge 가 필요한 포맷, 또는 AVC 여부가 불확실한 mp4 를 임시 파일에 먼저 저장.
// moov atom 이 파일 앞쪽에 정상 배치되어 재생 가능.
// mp4 는 코덱 검사 후 HEVC 면 ffmpeg 로 AVC(H.264) 변환 후 전송.
function handleStreamTempFile(req, res, opts) {
  const { igurl, idx, fmt, ext, fnPrefix, isDownload } = opts;

  const uniq    = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const tmpPath = path.join(os.tmpdir(), `reelsnap_${uniq}.${ext}`);
  const avcPath = path.join(os.tmpdir(), `reelsnap_${uniq}_avc.mp4`);

  console.log(`[stream-temp] idx=${idx} fmt=${fmt} ext=${ext} → ${tmpPath}`);

  const args = [
    '--playlist-items', String(idx),
    '--format', fmt,
    '--merge-output-format', 'mp4',
    '--no-warnings',
    '--no-part',
    ...commonYtDlpArgs(igurl),
  ];
  args.push('-o', tmpPath, igurl);

  const child = spawn(YT_DLP_BIN, args);
  let cleanupDone = false;

  function cleanup() {
    if (cleanupDone) return;
    cleanupDone = true;
    for (const p of [tmpPath, avcPath]) {
      fs.unlink(p, (err) => {
        if (!err) console.log('[stream-temp] 삭제:', p);
      });
    }
  }

  child.stderr.on('data', d => { const m = d.toString().trim(); if (m) console.log('[yt-dlp]', m); });

  child.on('error', (e) => {
    console.error('[stream-temp] spawn 오류:', e.message);
    if (!res.headersSent) { res.writeHead(500); res.end(e.message); }
    cleanup();
  });

  child.on('close', async (code) => {
    if (res.headersSent || cleanupDone) return; // 이미 클라이언트 끊김 처리됨
    if (code !== 0 || !fs.existsSync(tmpPath)) {
      res.writeHead(500); res.end('yt-dlp 다운로드 실패');
      cleanup();
      return;
    }

    // mp4 코덱 검사 → HEVC 면 AVC(H.264) 로 변환
    let servePath = tmpPath;
    if (ext === 'mp4' && FFMPEG_PATH) {
      const codec = await probeVideoCodec(tmpPath);
      if (codec) console.log(`[stream-temp] 비디오 코덱: ${codec}`);
      if (codec && HEVC_NAMES.has(codec)) {
        console.log(`[stream-temp] HEVC 감지 → AVC 변환 대기 (진행 중 ${activeTranscodes}/${MAX_CONCURRENT_TRANSCODES})`);
        await acquireTranscodeSlot();
        // 슬롯 대기 중 클라이언트가 끊었으면 변환 자체를 생략
        if (cleanupDone || res.destroyed) { releaseTranscodeSlot(); cleanup(); return; }
        try {
          console.log('[stream-temp] AVC 변환 시작 (시간이 걸릴 수 있음)');
          await transcodeToAvc(tmpPath, avcPath);
          servePath = avcPath;
          console.log('[stream-temp] AVC 변환 완료');
        } catch (e) {
          // 변환 실패 시 원본이라도 전송 (다운로드 자체는 성공시킴)
          console.error('[stream-temp] AVC 변환 실패 — 원본 전송:', e.message);
        } finally {
          releaseTranscodeSlot();
        }
      }
      // 변환 대기 중 클라이언트가 끊었으면 중단
      if (cleanupDone || res.destroyed) { cleanup(); return; }
    }

    // 파일 완성 → 브라우저로 전송
    let stat;
    try { stat = fs.statSync(servePath); }
    catch (e) { res.writeHead(500); res.end('temp 파일 접근 실패'); cleanup(); return; }

    const contentType = ext === 'm4a' ? 'audio/mp4' : 'video/mp4';
    const headers = {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    };
    if (isDownload) headers['Content-Disposition'] = `attachment; filename="${fnPrefix}_${idx}.${ext}"`;
    res.writeHead(200, headers);

    const readStream = fs.createReadStream(servePath);
    readStream.pipe(res);
    readStream.on('close', cleanup);
    readStream.on('error', cleanup);
  });

  // 클라이언트가 중간에 연결 끊으면 yt-dlp 중단 + temp 정리
  req.on('close', () => {
    try { child.kill(); } catch {}
    cleanup();
  });
}

// ─── quickstream: 메타데이터 없이 바로 다운로드 (일괄 다운로드용) ──
// temp 파일 경유 — 코덱 검사 후 HEVC 면 AVC(H.264) 자동 변환
function handleQuickStream(req, res) {
  const qs         = parseUrl(req.url).searchParams;
  const igurl      = normalizeIgUrl(qs.get('igurl'));
  const idx        = parseInt(qs.get('idx') || '1', 10);
  const quality    = qs.get('q') || 'low'; // low=최저화질, best=최고화질
  const fnPrefix   = qs.get('fn')  || 'download';
  const isDownload = qs.get('dl')  === '1';

  if (!igurl) { res.writeHead(400); res.end('igurl 파라미터 필요'); return; }

  // AVC 우선 muxed 스트림 (+ 연산자 사용 금지 → merge 불필요)
  const fmt = quality === 'best' ? FMT_BEST_AVC : FMT_WORST_AVC;

  console.log(`[quickstream] idx=${idx} q=${quality} ${igurl}`);
  handleStreamTempFile(req, res, { igurl, idx, fmt, ext: 'mp4', fnPrefix, isDownload });
}

// ─── 썸네일 프록시 ────────────────────────────────────────
function handleThumb(req, res) {
  const src = parseUrl(req.url).searchParams.get('url');
  if (!src) { res.writeHead(400); res.end('url 파라미터 필요'); return; }

  try {
    const parsed    = new URL(src);
    const transport = parsed.protocol === 'https:' ? https : http;
    const proxyReq  = transport.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.instagram.com/',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      },
    }, (upstream) => {
      res.writeHead(upstream.statusCode, {
        'Content-Type': upstream.headers['content-type'] || 'image/jpeg',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      });
      upstream.pipe(res);
    });
    proxyReq.on('error', (e) => { if (!res.headersSent) { res.writeHead(502); res.end(); } });
    proxyReq.setTimeout(8000, () => { proxyReq.destroy(); if (!res.headersSent) { res.writeHead(504); res.end(); } });
  } catch (e) {
    res.writeHead(400); res.end('잘못된 URL');
  }
}

// ─── HTTP 서버 ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { pathname } = parseUrl(req.url);
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${pathname}`);

  if      (pathname === '/thumb')       handleThumb(req, res);
  else if (pathname === '/stream')      handleStream(req, res);
  else if (pathname === '/quickstream') handleQuickStream(req, res);
  else if (pathname === '/health') {
    // 진단용 — yt-dlp 버전, JS 런타임 감지 결과, ffmpeg 유무를 한눈에 확인.
    // YouTube 가 안 될 때 여기부터 본다 (youtubeReady 가 false 면 그게 원인).
    const [ytdlpVer, denoVer, bunVer] = await Promise.all([
      probeBin(YT_DLP_BIN, ['--version']),
      probeBin('deno', ['--version']),
      probeBin('bun', ['--version']),
    ]);
    const runtimes = {};
    if (denoVer) runtimes.deno = denoVer.split('\n')[0];
    if (bunVer)  runtimes.bun  = bunVer;
    const nodeMajor = parseInt((process.versions.node || '0').split('.')[0], 10);
    if (nodeMajor >= 24) runtimes.node = process.version;   // yt-dlp 가 쓰는 --permission 은 Node 24+
    const youtubeReady = JS_RUNTIMES_SUPPORTED && Object.keys(runtimes).length > 0;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: !!ytdlpVer,
      platform: process.platform,
      node: process.version,
      ytdlp: ytdlpVer || null,
      ytdlpPath: YT_DLP_BIN,
      ffmpeg: FFMPEG_PATH || null,
      jsRuntimesOption: JS_RUNTIMES_SUPPORTED,   // yt-dlp 가 --js-runtimes 를 지원하는가
      jsRuntimes: runtimes,                      // 실제로 쓸 수 있는 JS 런타임
      youtubeReady,                              // false 면 YouTube 다운로드가 전부 실패한다
      hint: youtubeReady ? null
        : (!ytdlpVer ? 'yt-dlp 를 찾을 수 없습니다.'
        : !JS_RUNTIMES_SUPPORTED ? 'yt-dlp 가 구버전입니다 — 최신 바이너리로 교체하세요.'
        : 'JS 런타임이 없습니다 — deno 를 설치하거나 Node 24 이상에서 실행하세요.'),
    }, null, 2));

  } else if (pathname === '/msec') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ msec: Date.now() / 1000 }));

  } else if (pathname === '/api/convert') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { target_url } = JSON.parse(body);
        if (!isSupportedUrl(target_url)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: false,
            html: '지원하지 않는 URL입니다. (Instagram, YouTube 지원)'
          }));
        }
        const cached = getCached(target_url);
        if (cached) {
          console.log('[cache] 히트:', target_url);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(cached));
        }
        const result = await getMediaInfo(target_url);
        if (result.success) setCache(target_url, result);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        let msg = err.message;
        if (msg.includes('login') || msg.includes('private')) msg = '비공개 계정이거나 로그인이 필요한 게시물입니다.';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, html: msg }));
      }
    });

  } else {
    // index.html 서빙 (Render에서도 HTML 직접 접근 가능)
    const name = (pathname === '/' || pathname === '') ? 'index.html' : pathname.slice(1);
    fs.readFile(path.join(__dirname, name), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const ct = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json' };
      res.writeHead(200, { 'Content-Type': ct[path.extname(name)] || 'text/plain' });
      res.end(data);
    });
  }
});

// 기동 준비 — 리스닝 전에 yt-dlp / JS 런타임 점검을 끝낸다.
// (listen 후에 검사하면 첫 몇 백 ms 요청이 --js-runtimes 없이 나가 YouTube 가 실패한다)
(async () => {
  console.log('');
  const v = await checkYtDlp();
  if (!v) {
    console.log('❌ yt-dlp 를 찾을 수 없습니다.');
    console.log('   Windows: yt-dlp.exe 를 이 폴더에 넣고 재시작');
    console.log('   Render:  render.yaml buildCommand 확인');
  } else {
    console.log(`✅ yt-dlp ${v} 감지됨`);
  }

  // YouTube 전용: JS 챌린지 런타임 준비 상태 점검
  JS_RUNTIMES_SUPPORTED = v ? await detectJsRuntimesOption() : false;
  const nodeMajor = parseInt((process.versions.node || '0').split('.')[0], 10);
  const hasDeno   = !!(await probeBin('deno', ['--version']));
  if (v && !JS_RUNTIMES_SUPPORTED) {
    console.log('⚠️  yt-dlp 가 --js-runtimes 를 지원하지 않습니다 (구버전).');
    console.log('   → YouTube 다운로드가 전부 실패합니다. yt-dlp 를 최신으로 교체하세요.');
  } else if (hasDeno || nodeMajor >= 24) {
    console.log(`✅ YouTube JS 런타임: ${hasDeno ? 'deno' : `node ${process.version}`}`);
  } else {
    console.log(`⚠️  JS 런타임이 없습니다 (node ${process.version}, deno 없음).`);
    console.log('   → YouTube 다운로드가 전부 실패합니다. deno 설치 또는 Node 24 이상 필요.');
  }

  server.listen(PORT, () => {
    console.log(`✅ http://localhost:${PORT}   (진단: /health)`);
    console.log('   종료: Ctrl+C\n');
  });
})();

/**
 * Instagram 다운로더 - yt-dlp 기반 프록시 서버
 * 로컬 실행: node server.js  →  http://localhost:3000
 * Render 배포: render.yaml 참고
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const { exec, spawn } = require('child_process');

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

let YT_DLP_BIN, YT_DLP_CMD;
if (IS_WIN && fs.existsSync(LOCAL_EXE)) {
  // Windows: 폴더 내 .exe
  YT_DLP_BIN = LOCAL_EXE;
  YT_DLP_CMD = `"${LOCAL_EXE}"`;
} else if (!IS_WIN && fs.existsSync(LOCAL_BIN)) {
  // Linux: curl로 받은 폴더 내 바이너리 (Render 빌드)
  YT_DLP_BIN = LOCAL_BIN;
  YT_DLP_CMD = `"${LOCAL_BIN}"`;
} else {
  // 시스템 PATH 폴백
  YT_DLP_BIN = 'yt-dlp';
  YT_DLP_CMD = 'yt-dlp';
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

// ─── 지원 플랫폼 ──────────────────────────────────────────
const SUPPORTED_HOSTS = [
  'instagram.com',
  'youtube.com',
  'youtu.be',
  'm.youtube.com',
];
function isSupportedUrl(url) {
  if (!url) return false;
  return SUPPORTED_HOSTS.some(h => url.includes(h));
}

function checkYtDlp() {
  return new Promise((resolve) => {
    exec(`${YT_DLP_CMD} --version`, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

// URL 파싱 헬퍼 (WHATWG URL API 사용 — url.parse 경고 제거)
function parseUrl(reqUrl) {
  return new URL(reqUrl, `http://localhost:${PORT}`);
}

// ─── 메타데이터 추출 ──────────────────────────────────────
function getMediaInfo(instagramUrl) {
  return new Promise((resolve, reject) => {
    let cmd = `${YT_DLP_CMD} --dump-json --no-warnings`;
    if (FFMPEG_PATH) cmd += ` --ffmpeg-location "${FFMPEG_PATH}"`;
    cmd += ` "${instagramUrl}"`;
    console.log('[yt-dlp] 메타데이터 조회:', instagramUrl);

    exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));

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
            vf.sort((a, b) => (b.height || 0) - (a.height || 0));
            vf.forEach(f => {
              const q = f.height ? `${f.height}p` : (f.format_note || 'HD');
              links.push({ quality: q, type: 'video', index: idx, igurl: instagramUrl, fmtId: f.format_id, thumbnail: itemThumb });
            });
            if (!vf.length) {
              // muxed 포맷이 없으면 yt-dlp가 자체 선택하도록 best 포맷 문자열 사용
              links.push({ quality: 'HD', type: 'video', index: idx, igurl: instagramUrl, fmtId: 'best[ext=mp4][vcodec!=none][acodec!=none]/best[ext=mp4]/best', thumbnail: itemThumb });
            }
          } else {
            links.push({ quality: 'HD', type: 'video', index: idx, igurl: instagramUrl, fmtId: 'best', thumbnail: itemThumb });
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
function handleStream(req, res) {
  const qs         = parseUrl(req.url).searchParams;
  const igurl      = qs.get('igurl');
  const idx        = parseInt(qs.get('idx') || '1', 10);
  const fmt        = qs.get('fmt') || 'best[ext=mp4][vcodec!=none][acodec!=none]/best[ext=mp4]/best';
  const ext        = qs.get('ext') || 'mp4';   // mp4(기본) / m4a(오디오) 등
  const fnPrefix   = qs.get('fn')  || 'download';
  const isDownload = qs.get('dl')  === '1';

  if (!igurl) { res.writeHead(400); res.end('igurl 파라미터 필요'); return; }

  console.log(`[stream] idx=${idx} fmt=${fmt} ext=${ext} ${igurl}`);

  const args = ['--playlist-items', String(idx), '--format', fmt, '--no-warnings'];
  // 비디오(merge 필요한 포맷) 대응 — mp4 출력 컨테이너로 합침
  if (ext === 'mp4') args.push('--merge-output-format', 'mp4');
  if (FFMPEG_PATH)   args.push('--ffmpeg-location', FFMPEG_PATH);
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

  child.stdout.pipe(res);
  child.stderr.on('data', d => { const m = d.toString().trim(); if (m) console.log('[yt-dlp]', m); });
  child.on('error', (e) => { if (!headerSent && !res.headersSent) { res.writeHead(500); res.end(e.message); } });
  child.on('close', (code) => { if (code !== 0 && !headerSent) { res.writeHead(500); res.end('yt-dlp 실패'); } });
  req.on('close', () => child.kill());
}

// ─── quickstream: 메타데이터 없이 바로 스트리밍 (일괄 다운로드용) ──
function handleQuickStream(req, res) {
  const qs         = parseUrl(req.url).searchParams;
  const igurl      = qs.get('igurl');
  const idx        = parseInt(qs.get('idx') || '1', 10);
  const quality    = qs.get('q') || 'low'; // low=최저화질, best=최고화질
  const fnPrefix   = qs.get('fn')  || 'download';
  const isDownload = qs.get('dl')  === '1';

  if (!igurl) { res.writeHead(400); res.end('igurl 파라미터 필요'); return; }

  // ffmpeg 없이도 재생 가능한 muxed 스트림만 선택 (+ 연산자 사용 금지)
  // worst[height]/best[height] → 영상+음성이 이미 합쳐진 포맷만 대상
  const fmt = quality === 'best'
    ? 'best[ext=mp4][vcodec!=none][acodec!=none]/best[ext=mp4]/best'
    : 'worst[ext=mp4][vcodec!=none][acodec!=none]/worst[ext=mp4]/worst';

  console.log(`[quickstream] idx=${idx} q=${quality} ${igurl}`);

  const args = ['--playlist-items', String(idx), '--format', fmt, '--no-warnings'];
  if (FFMPEG_PATH) args.push('--ffmpeg-location', FFMPEG_PATH);
  args.push('-o', '-', igurl);

  const child = spawn(YT_DLP_BIN, args);
  let headerSent = false;

  child.stdout.once('data', () => {
    if (headerSent) return;
    headerSent = true;
    const headers = {
      'Content-Type': 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    };
    if (isDownload) headers['Content-Disposition'] = `attachment; filename="${fnPrefix}_${idx}.mp4"`;
    res.writeHead(200, headers);
  });

  child.stdout.pipe(res);
  child.stderr.on('data', d => { const m = d.toString().trim(); if (m) console.log('[quickstream]', m); });
  child.on('error', (e) => { if (!headerSent && !res.headersSent) { res.writeHead(500); res.end(e.message); } });
  child.on('close', (code) => { if (code !== 0 && !headerSent) { res.writeHead(500); res.end('yt-dlp 실패'); } });
  req.on('close', () => child.kill());
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
  else if (pathname === '/msec') {
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

server.listen(PORT, async () => {
  console.log('');
  const v = await checkYtDlp();
  if (!v) {
    console.log('❌ yt-dlp 를 찾을 수 없습니다.');
    console.log('   Windows: yt-dlp.exe 를 이 폴더에 넣고 재시작');
    console.log('   Render:  render.yaml buildCommand 확인');
  } else {
    console.log(`✅ yt-dlp ${v} 감지됨`);
    console.log(`✅ http://localhost:${PORT}`);
  }
  console.log('   종료: Ctrl+C\n');
});

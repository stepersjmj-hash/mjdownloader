/**
 * Instagram 다운로더 - yt-dlp 기반 프록시 서버
 * 로컬 실행: node server.js  →  http://localhost:3000
 * Render 배포: render.yaml 참고
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const urlMod = require('url');
const { exec, spawn } = require('child_process');

// Render는 PORT 환경변수를 주입함
const PORT = process.env.PORT || 3000;

// ─── yt-dlp 경로 (Windows .exe → Linux 바이너리 → 시스템 PATH 순) ───
const LOCAL_EXE = path.join(__dirname, 'yt-dlp.exe'); // Windows
const LOCAL_BIN = path.join(__dirname, 'yt-dlp');     // Linux (Render 빌드)

let YT_DLP_BIN, YT_DLP_CMD;
if (fs.existsSync(LOCAL_EXE)) {
  YT_DLP_BIN = LOCAL_EXE;
  YT_DLP_CMD = `"${LOCAL_EXE}"`;
} else if (fs.existsSync(LOCAL_BIN)) {
  YT_DLP_BIN = LOCAL_BIN;
  YT_DLP_CMD = `"${LOCAL_BIN}"`;
} else {
  YT_DLP_BIN = 'yt-dlp';
  YT_DLP_CMD = 'yt-dlp';
}

function checkYtDlp() {
  return new Promise((resolve) => {
    exec(`${YT_DLP_CMD} --version`, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

// ─── 메타데이터 추출 ──────────────────────────────────────
function getMediaInfo(instagramUrl) {
  return new Promise((resolve, reject) => {
    const cmd = `${YT_DLP_CMD} --dump-json --no-warnings "${instagramUrl}"`;
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

          // 항목별 썸네일: thumbnails 배열 중 가장 큰 것 또는 thumbnail 문자열
          const itemThumb = (() => {
            if (item.thumbnails && item.thumbnails.length) {
              const sorted = [...item.thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
              return sorted[0].url || null;
            }
            return item.thumbnail || null;
          })();

          if (isImg && item.url) {
            // 이미지는 CDN URL 직접 사용 (IP 잠금 없음)
            links.push({ url: item.url, quality: 'Original', type, index: idx, igurl: instagramUrl, thumbnail: itemThumb });
          } else if (item.formats && item.formats.length > 0) {
            const vf = item.formats.filter(f => f.vcodec && f.vcodec !== 'none');
            vf.sort((a, b) => (b.height || 0) - (a.height || 0));
            // 서버 스트림 URL 사용 (CDN 직접 X) — 같은 항목은 썸네일 공유
            vf.forEach(f => {
              const q = f.height ? `${f.height}p` : (f.format_note || 'HD');
              links.push({ quality: q, type: 'video', index: idx, igurl: instagramUrl, fmtId: f.format_id, thumbnail: itemThumb });
            });
            if (!vf.length) {
              links.push({ quality: 'HD', type: 'video', index: idx, igurl: instagramUrl, fmtId: 'best', thumbnail: itemThumb });
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
// /stream?igurl=<url>&idx=<N>&fmt=<formatId>&dl=1(선택)
// yt-dlp가 직접 데이터를 파이프 → CORS·IP 잠금 모두 우회
function handleStream(req, res) {
  const qs      = new urlMod.URL(req.url, `http://localhost:${PORT}`).searchParams;
  const igurl   = qs.get('igurl');
  const idx     = parseInt(qs.get('idx') || '1', 10);
  const fmt     = qs.get('fmt') || 'best[ext=mp4]/best';
  const isDownload = qs.get('dl') === '1';

  if (!igurl) { res.writeHead(400); res.end('igurl 파라미터 필요'); return; }

  console.log(`[stream] idx=${idx} fmt=${fmt} ${igurl}`);

  // yt-dlp 인수: 지정 아이템을 stdout으로 파이프
  const args = [
    '--playlist-items', String(idx),
    '--format', fmt,
    '-o', '-',
    '--no-warnings',
    igurl,
  ];

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
    if (isDownload) {
      headers['Content-Disposition'] = `attachment; filename="instagram_${idx}.mp4"`;
    }
    res.writeHead(200, headers);
  });

  child.stdout.pipe(res);

  child.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg) console.log('[yt-dlp]', msg);
  });

  child.on('error', (e) => {
    console.error('[spawn 오류]', e.message);
    if (!headerSent && !res.headersSent) {
      res.writeHead(500); res.end(e.message);
    }
  });

  child.on('close', (code) => {
    if (code !== 0 && !headerSent) {
      res.writeHead(500); res.end('yt-dlp 실패 (code ' + code + ')');
    }
  });

  req.on('close', () => child.kill());
}

// ─── HTTP 서버 ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { pathname } = urlMod.parse(req.url);
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${pathname}`);

  // /thumb?url=... → 썸네일 이미지 프록시 (서버 경유로 IP 잠금 우회)
  if (pathname === '/thumb') {
    const qs  = new urlMod.URL(req.url, `http://localhost:${PORT}`).searchParams;
    const src = qs.get('url');
    if (!src) { res.writeHead(400); res.end('url 파라미터 필요'); return; }

    try {
      const parsed    = new urlMod.URL(src);
      const transport = parsed.protocol === 'https:' ? require('https') : require('http');

      const proxyReq = transport.get({
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

      proxyReq.on('error', (e) => {
        console.error('[thumb 오류]', e.message);
        if (!res.headersSent) { res.writeHead(502); res.end(); }
      });
      proxyReq.setTimeout(8000, () => {
        proxyReq.destroy();
        if (!res.headersSent) { res.writeHead(504); res.end(); }
      });
    } catch (e) {
      res.writeHead(400); res.end('잘못된 URL');
    }
    return;
  }

  // /stream → yt-dlp 파이프 스트리밍
  if (pathname === '/stream') {
    handleStream(req, res);

  // /msec → 서버 시간
  } else if (pathname === '/msec') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ msec: Date.now() / 1000 }));

  // /api/convert → 메타데이터
  } else if (pathname === '/api/convert') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { target_url } = JSON.parse(body);
        if (!target_url?.includes('instagram.com')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, html: '올바른 인스타그램 URL이 아닙니다.' }));
        }
        const result = await getMediaInfo(target_url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('[변환 오류]', err.message);
        let msg = err.message;
        if (msg.includes('login') || msg.includes('private')) msg = '비공개 계정이거나 로그인이 필요한 게시물입니다.';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, html: msg }));
      }
    });

  // 정적 파일
  } else {
    const name = pathname === '/' ? 'mj-downloader.html' : pathname.slice(1);
    fs.readFile(path.join(__dirname, name), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const ct = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript' };
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
    console.log('   https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe');
    console.log('   위 파일을 server.js 와 같은 폴더에 넣고 재시작하세요.');
  } else {
    console.log(`✅ yt-dlp ${v} 감지됨`);
    console.log(`✅ http://localhost:${PORT}`);
  }
  console.log('   종료: Ctrl+C\n');
});

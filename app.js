// ════════════════════════════════════════════════
//  app.js — 코어: 공통 유틸 + 탭 전환 + 백엔드 분기
//  각 플랫폼 로직은 app_<platform>.js 에서 처리.
// ════════════════════════════════════════════════

// ── 백엔드 설정 ──────────────────────────────────────────────
// 페이지가 서빙되는 도메인에서 직접 API 호출 (상대경로)
//   - 로컬 (localhost)        → 상대경로
//   - NAS 도메인              → 상대경로 (서버가 프론트도 서빙)
//   - Render 도메인           → 상대경로 (동일)
//   - GitHub Pages 등 외부    → REMOTE_BACKEND 사용
const REMOTE_BACKEND = 'https://mjdownloader-fo5w.onrender.com';

const host = location.hostname;
const isGitHubPages = host.endsWith('.github.io');
const BACKEND = isGitHubPages ? REMOTE_BACKEND : '';

const API_CONVERT = BACKEND + '/api/convert';
const API_MSEC    = BACKEND + '/msec';

// ════════════════════════════════════════════════
//  공통 유틸리티 (모든 플랫폼 모듈에서 사용)
// ════════════════════════════════════════════════

async function getServerTime() {
  try {
    const resp = await fetch(API_MSEC);
    const data = await resp.json();
    return Math.round(data.msec * 1000);
  } catch (e) {
    return Date.now();
  }
}

function getMediaType(url, ext) {
  const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm'];
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
  if (ext && videoExts.includes(ext.toLowerCase())) return 'video';
  if (ext && imageExts.includes(ext.toLowerCase())) return 'image';
  if (url && url.includes('video')) return 'video';
  return 'video';
}

function getQualityLabel(link) {
  if (link.quality) return link.quality;
  if (link.label)   return link.label;
  const url = link.url || link.link || '';
  if (url.includes('1080') || url.includes('hd')) return 'HD 1080p';
  if (url.includes('720'))  return 'HD 720p';
  if (url.includes('480'))  return 'SD 480p';
  if (url.includes('360'))  return 'SD 360p';
  return '다운로드';
}

// 썸네일 URL → 서버 /thumb 경유 (IP 잠금 우회)
function thumbUrl(rawUrl) {
  if (!rawUrl) return '';
  return BACKEND + '/thumb?url=' + encodeURIComponent(rawUrl);
}

// yt-dlp 스트림 URL 생성 (Instagram 등 범용)
// link: { type, url, igurl, index, fmtId, ... }
// opts: { forDownload, ext, fnPrefix }
function streamUrl(link, opts = {}) {
  const { forDownload = false, ext = 'mp4', fnPrefix = 'download' } = opts;

  if (link.type === 'image' && link.url) {
    return link.url; // 이미지는 CDN URL 직접 사용
  }
  const url = link.igurl || link.url || '';
  const idx = link.index || 1;
  const fmt = link.fmtId ? encodeURIComponent(link.fmtId + '/best') : 'best[ext%3Dmp4]%2Fbest';
  const qs  = [
    `igurl=${encodeURIComponent(url)}`,
    `idx=${idx}`,
    `fmt=${fmt}`,
    `ext=${encodeURIComponent(ext)}`,
    `fn=${encodeURIComponent(fnPrefix)}`,
    forDownload ? 'dl=1' : '',
  ].filter(Boolean).join('&');
  return `${BACKEND}/stream?${qs}`;
}

// 상태 메시지 표시 (플랫폼별 #<prefix>Status DOM 에 표시)
function showStatus(prefix, msg, type) {
  const el = document.getElementById(prefix + 'Status');
  if (!el) return;
  el.innerHTML = msg;
  el.className = 'status ' + (type || '');
  el.style.display = 'block';
}

function hideStatus(prefix) {
  const el = document.getElementById(prefix + 'Status');
  if (el) el.style.display = 'none';
}

// 클립보드 → 입력창 붙여넣기
async function pasteToInput(inputId, statusPrefix) {
  try {
    const text = await navigator.clipboard.readText();
    const input = document.getElementById(inputId);
    if (input) input.value = text || '';
  } catch (e) {
    const input = document.getElementById(inputId);
    if (input) input.focus();
    showStatus(statusPrefix, '자동 붙여넣기가 차단되었습니다. Ctrl+V로 직접 붙여넣어주세요.', 'error');
    setTimeout(() => hideStatus(statusPrefix), 3000);
  }
}

// ════════════════════════════════════════════════
//  탭 전환
// ════════════════════════════════════════════════

function initTabs() {
  const tabs     = document.querySelectorAll('.tab');
  const sections = document.querySelectorAll('.platform-section');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const platform = tab.dataset.platform;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      sections.forEach(s => {
        s.classList.toggle('hidden', s.dataset.platform !== platform);
      });
      document.body.dataset.activePlatform = platform;
    });
  });

  // 초기 활성 플랫폼 표시
  const initialActive = document.querySelector('.tab.active');
  if (initialActive) document.body.dataset.activePlatform = initialActive.dataset.platform;
}

document.addEventListener('DOMContentLoaded', initTabs);

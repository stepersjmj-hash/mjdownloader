// ── 백엔드 설정 ──────────────────────────────────────────────
const RENDER_URL = 'https://mjdownloader-bbm5.onrender.com';

// 로컬이면 상대경로, GitHub Pages 등 외부면 Render URL 사용
const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const BACKEND = isLocal ? '' : RENDER_URL;

const API_CONVERT = BACKEND + '/api/convert';
const API_MSEC    = BACKEND + '/msec';

// ════════════════════════════════════════════════
//  유틸리티
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

// yt-dlp 스트림 URL 생성: 서버가 yt-dlp로 직접 파이프 → IP 잠금 우회
function streamUrl(link, forDownload) {
  if (link.type === 'image' && link.url) {
    return link.url; // 이미지는 CDN URL 직접 사용
  }
  const igurl = link.igurl || '';
  const idx   = link.index || 1;
  const fmt   = link.fmtId ? encodeURIComponent(link.fmtId + '/best') : 'best[ext%3Dmp4]%2Fbest';
  return `${BACKEND}/stream?igurl=${encodeURIComponent(igurl)}&idx=${idx}&fmt=${fmt}${forDownload ? '&dl=1' : ''}`;
}

function showStatus(msg, type) {
  const el = document.getElementById('status');
  el.innerHTML  = msg;
  el.className  = 'status ' + (type || '');
  el.style.display = 'block';
}

function hideStatus() {
  document.getElementById('status').style.display = 'none';
}

// ════════════════════════════════════════════════
//  미리보기 플레이어
// ════════════════════════════════════════════════

function renderPreview(links, container) {
  if (!links || links.length === 0) return;

  const previews = [];
  const seenIdx  = new Set();
  links.forEach(link => {
    const idx = link.index || 1;
    if (!seenIdx.has(idx)) { seenIdx.add(idx); previews.push(link); }
  });

  let current = 0;

  const wrapper = document.createElement('div');
  wrapper.className = 'preview-container';

  function makeMediaEl(item) {
    if (item.type === 'image') {
      const img = document.createElement('img');
      img.src = streamUrl(item, false);
      img.alt = '이미지 미리보기';
      return img;
    }
    const vid     = document.createElement('video');
    vid.controls  = true;
    vid.preload   = 'metadata';
    vid.src       = streamUrl(item, false);
    if (item.thumbnail) vid.poster = thumbUrl(item.thumbnail);
    return vid;
  }

  wrapper.appendChild(makeMediaEl(previews[0]));
  container.appendChild(wrapper);

  if (previews.length > 1) {
    const nav     = document.createElement('div');
    nav.className = 'preview-nav';

    const btnPrev = document.createElement('button');
    btnPrev.textContent = '◀ 이전';
    btnPrev.disabled    = true;

    const counter = document.createElement('span');
    counter.className   = 'preview-counter';
    counter.textContent = `1 / ${previews.length}`;

    const btnNext = document.createElement('button');
    btnNext.textContent = '다음 ▶';

    function updatePreview() {
      wrapper.replaceChild(makeMediaEl(previews[current]), wrapper.firstChild);
      counter.textContent = `${current + 1} / ${previews.length}`;
      btnPrev.disabled    = current === 0;
      btnNext.disabled    = current === previews.length - 1;
    }

    btnPrev.onclick = () => { if (current > 0)                   { current--; updatePreview(); } };
    btnNext.onclick = () => { if (current < previews.length - 1) { current++; updatePreview(); } };

    nav.appendChild(btnPrev);
    nav.appendChild(counter);
    nav.appendChild(btnNext);
    container.appendChild(nav);
  }
}

// ════════════════════════════════════════════════
//  다운로드 결과 렌더링
// ════════════════════════════════════════════════

function renderResults(data, sourceUrl) {
  const container = document.getElementById('results');
  container.innerHTML = '';

  if (!data || !data.success) {
    const msg = data && data.html ? data.html : '처리할 수 없는 링크입니다. 공개 게시물의 URL인지 확인해주세요.';
    showStatus(msg.replace(/<[^>]+>/g, ''), 'error');
    return;
  }

  hideStatus();

  const links = data.links || [];
  if (links.length === 0) {
    showStatus('다운로드 가능한 파일을 찾지 못했습니다.', 'error');
    return;
  }

  renderPreview(links, container);

  const uniqueMedia = new Set(links.map(l => l.index || 1)).size;
  const title       = document.createElement('div');
  title.className   = 'result-title';
  title.textContent = uniqueMedia > 1
    ? `${uniqueMedia}개 미디어 발견 (총 ${links.length}개 화질)`
    : `${links.length}개 화질 선택 가능`;
  container.appendChild(title);

  links.forEach((link, i) => {
    const type         = link.type || 'video';
    const qualityLabel = getQualityLabel(link);
    const mediaNum     = link.index || (i + 1);
    const icon         = type === 'video' ? '🎬' : type === 'image' ? '🖼️' : '🎵';
    const typeLabel    = type === 'video' ? '비디오' : type === 'image' ? '이미지' : '오디오';
    const ext          = type === 'image' ? 'jpg' : 'mp4';

    const thumbHtml = link.thumbnail
      ? `<img src="${thumbUrl(link.thumbnail)}" alt="썸네일" onerror="this.parentElement.innerHTML='${icon}'">
         ${type === 'video' ? '<span class="play-badge">▶</span>' : ''}`
      : icon;

    const item = document.createElement('div');
    item.className = 'media-item';
    item.innerHTML = `
      <div class="media-info">
        <div class="media-icon ${type}">${thumbHtml}</div>
        <div>
          <div class="media-label">${typeLabel} #${mediaNum}</div>
          <div class="media-quality">${qualityLabel}</div>
        </div>
      </div>
      <a href="${streamUrl(link, true)}" class="btn-dl" download="instagram_${mediaNum}_${qualityLabel}.${ext}">
        ⬇ 다운로드
      </a>
    `;
    container.appendChild(item);
  });
}

// ════════════════════════════════════════════════
//  단일 URL 다운로드
// ════════════════════════════════════════════════

async function startDownload() {
  const input = document.getElementById('urlInput');
  const url   = input.value.trim();

  if (!url) {
    showStatus('인스타그램 링크를 입력해주세요.', 'error');
    return;
  }

  if (!url.includes('instagram.com')) {
    showStatus('올바른 인스타그램 URL을 입력해주세요. (예: https://www.instagram.com/p/...)', 'error');
    return;
  }

  const btn = document.getElementById('downloadBtn');
  btn.disabled = true;
  document.getElementById('results').innerHTML = '';
  showStatus('<span class="spinner"></span> 처리 중...', 'loading');

  try {
    const ts  = Date.now();
    const _ts = await getServerTime();

    const body = { target_url: url, ts, _ts, _tsc: 0, _sv: 2 };

    const resp = await fetch(API_CONVERT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
      body:    JSON.stringify(body),
    });

    if (!resp.ok) throw new Error('서버 응답 오류: ' + resp.status);

    const data = await resp.json();
    renderResults(data, url);

  } catch (err) {
    if (err.name === 'TypeError' && err.message.includes('fetch')) {
      showStatus(
        'CORS 오류 발생: 브라우저 보안 정책으로 인해 로컬 파일에서 직접 API 호출이 차단되었습니다.<br>' +
        '해결 방법: VS Code Live Server, 또는 Python(<code>python -m http.server</code>)으로 서비스하거나, ' +
        '<strong>CORS 허용 브라우저 확장 프로그램</strong>을 설치 후 이용하세요.',
        'error'
      );
    } else {
      showStatus('오류 발생: ' + err.message, 'error');
    }
  } finally {
    btn.disabled = false;
  }
}

async function pasteUrl() {
  try {
    const text = await navigator.clipboard.readText();
    document.getElementById('urlInput').value = text || '';
  } catch (e) {
    document.getElementById('urlInput').focus();
    showStatus('자동 붙여넣기가 차단되었습니다. Ctrl+V로 직접 붙여넣어주세요.', 'error');
    setTimeout(() => hideStatus(), 3000);
  }
}

// ════════════════════════════════════════════════
//  일괄 다운로드
// ════════════════════════════════════════════════

// Instagram URL 추출 정규식
const IG_URL_RE = /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv|stories\/[^/]+)\/[A-Za-z0-9_-]+\/?/g;

function extractUrls() {
  const text  = document.getElementById('bulkText').value;
  const found = [...new Set(text.match(IG_URL_RE) || [])];

  const listEl  = document.getElementById('urlList');
  const itemsEl = document.getElementById('urlListItems');
  const titleEl = document.getElementById('urlListTitle');

  itemsEl.innerHTML = '';

  if (found.length === 0) {
    listEl.style.display = 'block';
    titleEl.textContent  = '인스타그램 URL을 찾지 못했습니다.';
    document.getElementById('bulkDlBtn').disabled = true;
    return;
  }

  found.forEach((url, i) => {
    const id   = `url_cb_${i}`;
    const item = document.createElement('div');
    item.className   = 'url-item';
    item.dataset.url = url;
    item.innerHTML   = `
      <input type="checkbox" id="${id}" value="${url}" checked>
      <label for="${id}">${url}</label>
      <span class="url-status" id="status_${i}"></span>
    `;
    itemsEl.appendChild(item);
  });

  titleEl.textContent = `${found.length}개 URL 발견`;
  document.getElementById('bulkDlBtn').disabled = false;
  listEl.style.display = 'block';
}

function clearBulk() {
  document.getElementById('bulkText').value         = '';
  document.getElementById('urlList').style.display  = 'none';
  document.getElementById('urlListItems').innerHTML = '';
  document.getElementById('bulkProgress').textContent = '';
}

function toggleAll() {
  const boxes      = document.querySelectorAll('#urlListItems input[type="checkbox"]');
  const allChecked = [...boxes].every(b => b.checked);
  boxes.forEach(b => b.checked = !allChecked);
}

function pickLowestQuality(links) {
  const videos = links.filter(l => l.type === 'video' || !l.type);
  if (!videos.length) return links[0] || null;
  videos.sort((a, b) => (parseInt(a.quality) || 9999) - (parseInt(b.quality) || 9999));
  return videos[0];
}

async function bulkDownload() {
  const checked = [...document.querySelectorAll('#urlListItems input[type="checkbox"]:checked')];
  if (!checked.length) {
    alert('다운로드할 URL을 선택해주세요.');
    return;
  }

  const btn      = document.getElementById('bulkDlBtn');
  const progress = document.getElementById('bulkProgress');
  btn.disabled   = true;

  const items     = document.querySelectorAll('#urlListItems .url-item');
  const statusMap = {};
  items.forEach((el, i) => {
    statusMap[el.dataset.url] = document.getElementById(`status_${i}`);
  });

  let done        = 0;
  const total     = checked.length;

  for (const cb of checked) {
    const igurl    = cb.value;
    const statusEl = statusMap[igurl];
    progress.textContent = `처리 중 ${done + 1} / ${total}`;
    if (statusEl) { statusEl.textContent = '⏳'; statusEl.className = 'url-status loading'; }

    try {
      // /quickstream 직접 호출 — 메타데이터 단계 생략, 최저화질 1회 실행
      const dlUrl  = `${BACKEND}/quickstream?igurl=${encodeURIComponent(igurl)}&idx=1&q=low&dl=1`;
      const anchor = document.createElement('a');
      anchor.href     = dlUrl;
      anchor.download = `instagram_${done + 1}_low.mp4`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);

      if (statusEl) { statusEl.textContent = '✅ 완료'; statusEl.className = 'url-status done'; }
    } catch (e) {
      console.error('[bulk]', igurl, e.message);
      if (statusEl) { statusEl.textContent = '❌ 실패'; statusEl.className = 'url-status fail'; }
    }

    done++;
    if (done < total) await new Promise(r => setTimeout(r, 1500));
  }

  progress.textContent = `완료 ${done} / ${total}`;
  btn.disabled = false;
}

// ════════════════════════════════════════════════
//  이벤트 초기화
// ════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('urlInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') startDownload();
  });
  document.getElementById('bulkText').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.ctrlKey) extractUrls();
  });
});

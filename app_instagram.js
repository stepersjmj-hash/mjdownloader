// ════════════════════════════════════════════════
//  app_instagram.js — Instagram 플랫폼 모듈
//  의존: app.js (BACKEND, API_CONVERT, thumbUrl, streamUrl, ...)
// ════════════════════════════════════════════════

(function() {
  'use strict';

  const STATUS_PREFIX = 'ig';

  // Instagram URL 추출 정규식
  const IG_URL_RE = /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv|stories\/[^/]+)\/[A-Za-z0-9_-]+\/?/g;

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
        img.src = streamUrl(item, { forDownload: false, fnPrefix: 'instagram' });
        img.alt = '이미지 미리보기';
        return img;
      }
      const vid     = document.createElement('video');
      vid.controls  = true;
      vid.preload   = 'metadata';
      vid.src       = streamUrl(item, { forDownload: false, fnPrefix: 'instagram' });
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
    const container = document.getElementById('igResults');
    container.innerHTML = '';

    if (!data || !data.success) {
      const msg = data && data.html ? data.html : '처리할 수 없는 링크입니다. 공개 게시물의 URL인지 확인해주세요.';
      showStatus(STATUS_PREFIX, msg.replace(/<[^>]+>/g, ''), 'error');
      return;
    }

    hideStatus(STATUS_PREFIX);

    const links = data.links || [];
    if (links.length === 0) {
      showStatus(STATUS_PREFIX, '다운로드 가능한 파일을 찾지 못했습니다.', 'error');
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

      const dlUrl = streamUrl(link, { forDownload: true, ext, fnPrefix: 'instagram' });

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
        <a href="${dlUrl}" class="btn-dl" download="instagram_${mediaNum}_${qualityLabel}.${ext}">
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
    const input = document.getElementById('igUrlInput');
    const url   = input.value.trim();

    if (!url) {
      showStatus(STATUS_PREFIX, '인스타그램 링크를 입력해주세요.', 'error');
      return;
    }

    if (!url.includes('instagram.com')) {
      showStatus(STATUS_PREFIX, '올바른 인스타그램 URL을 입력해주세요. (예: https://www.instagram.com/p/...)', 'error');
      return;
    }

    const btn = document.getElementById('igDownloadBtn');
    btn.disabled = true;
    document.getElementById('igResults').innerHTML = '';
    showStatus(STATUS_PREFIX, '<span class="spinner"></span> 처리 중...', 'loading');

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
        showStatus(STATUS_PREFIX,
          'CORS 오류 발생: 브라우저 보안 정책으로 인해 로컬 파일에서 직접 API 호출이 차단되었습니다.<br>' +
          '해결 방법: VS Code Live Server, 또는 Python(<code>python -m http.server</code>)으로 서비스하거나, ' +
          '<strong>CORS 허용 브라우저 확장 프로그램</strong>을 설치 후 이용하세요.',
          'error'
        );
      } else {
        showStatus(STATUS_PREFIX, '오류 발생: ' + err.message, 'error');
      }
    } finally {
      btn.disabled = false;
    }
  }

  // ════════════════════════════════════════════════
  //  일괄 다운로드
  // ════════════════════════════════════════════════

  function extractUrls() {
    const text  = document.getElementById('igBulkText').value;
    const found = [...new Set(text.match(IG_URL_RE) || [])];

    const listEl  = document.getElementById('igUrlList');
    const itemsEl = document.getElementById('igUrlListItems');
    const titleEl = document.getElementById('igUrlListTitle');

    itemsEl.innerHTML = '';

    if (found.length === 0) {
      listEl.style.display = 'block';
      titleEl.textContent  = '인스타그램 URL을 찾지 못했습니다.';
      document.getElementById('igBulkDlBtn').disabled = true;
      return;
    }

    found.forEach((url, i) => {
      const id   = `ig_url_cb_${i}`;
      const item = document.createElement('div');
      item.className   = 'url-item';
      item.dataset.url = url;
      item.innerHTML   = `
        <input type="checkbox" id="${id}" value="${url}" checked>
        <label for="${id}">${url}</label>
        <span class="url-status" id="ig_status_${i}"></span>
      `;
      itemsEl.appendChild(item);
    });

    titleEl.textContent = `${found.length}개 URL 발견`;
    document.getElementById('igBulkDlBtn').disabled = false;
    listEl.style.display = 'block';
  }

  function clearBulk() {
    document.getElementById('igBulkText').value        = '';
    document.getElementById('igUrlList').style.display = 'none';
    document.getElementById('igUrlListItems').innerHTML = '';
    document.getElementById('igBulkProgress').textContent = '';
  }

  function toggleAll() {
    const boxes      = document.querySelectorAll('#igUrlListItems input[type="checkbox"]');
    const allChecked = [...boxes].every(b => b.checked);
    boxes.forEach(b => b.checked = !allChecked);
  }

  async function bulkDownload() {
    const checked = [...document.querySelectorAll('#igUrlListItems input[type="checkbox"]:checked')];
    if (!checked.length) {
      alert('다운로드할 URL을 선택해주세요.');
      return;
    }

    const btn      = document.getElementById('igBulkDlBtn');
    const progress = document.getElementById('igBulkProgress');
    btn.disabled   = true;

    const items     = document.querySelectorAll('#igUrlListItems .url-item');
    const statusMap = {};
    items.forEach((el, i) => {
      statusMap[el.dataset.url] = document.getElementById(`ig_status_${i}`);
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
        const dlUrl  = `${BACKEND}/quickstream?igurl=${encodeURIComponent(igurl)}&idx=1&q=low&fn=instagram&dl=1`;
        const anchor = document.createElement('a');
        anchor.href     = dlUrl;
        anchor.download = `instagram_${done + 1}_low.mp4`;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);

        if (statusEl) { statusEl.textContent = '✅ 완료'; statusEl.className = 'url-status done'; }
      } catch (e) {
        console.error('[ig-bulk]', igurl, e.message);
        if (statusEl) { statusEl.textContent = '❌ 실패'; statusEl.className = 'url-status fail'; }
      }

      done++;
      if (done < total) await new Promise(r => setTimeout(r, 1500));
    }

    progress.textContent = `완료 ${done} / ${total}`;
    btn.disabled = false;
  }

  // ════════════════════════════════════════════════
  //  이벤트 바인딩
  // ════════════════════════════════════════════════

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('igDownloadBtn').addEventListener('click', startDownload);
    document.getElementById('igPasteBtn')   .addEventListener('click', () => pasteToInput('igUrlInput', STATUS_PREFIX));
    document.getElementById('igUrlInput')   .addEventListener('keydown', e => {
      if (e.key === 'Enter') startDownload();
    });

    document.getElementById('igExtractBtn') .addEventListener('click', extractUrls);
    document.getElementById('igClearBtn')   .addEventListener('click', clearBulk);
    document.getElementById('igToggleAllBtn').addEventListener('click', toggleAll);
    document.getElementById('igBulkDlBtn')  .addEventListener('click', bulkDownload);
    document.getElementById('igBulkText')   .addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.ctrlKey) extractUrls();
    });
  });

})();

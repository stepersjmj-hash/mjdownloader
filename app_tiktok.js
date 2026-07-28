// ════════════════════════════════════════════════
//  app_tiktok.js — TikTok 플랫폼 모듈
//  단일: YouTube 식 (메타 생략, 바로 /stream)
//  일괄: Instagram 식 (정규식 추출 → 체크박스 → 순차 다운로드)
//  의존: app.js (BACKEND, showStatus, hideStatus, pasteToInput, ...)
// ════════════════════════════════════════════════

(function() {
  'use strict';

  const STATUS_PREFIX = 'tt';

  // TikTok URL 추출 정규식
  //   - 표준:  https://www.tiktok.com/@user/video/1234567890  (쿼리스트링 제외하고 매칭)
  //   - 단축:  https://vm.tiktok.com/XXXX , https://vt.tiktok.com/XXXX
  const TT_URL_RE = /https?:\/\/(?:www\.|m\.)?tiktok\.com\/@[\w.-]+\/video\/\d+|https?:\/\/(?:vm|vt)\.tiktok\.com\/[A-Za-z0-9]+/g;

  // yt-dlp 포맷 문자열
  //   - AVC(h264) 우선: TikTok 은 h264 + h265(bytevc1) 를 함께 제공하는 경우가 대부분.
  //     h264 를 선택하면 서버 HEVC → AVC 변환 없이 즉시 다운로드 (NAS 부하·타임아웃 방지).
  //     h265 만 제공되는 영상은 서버가 자동 변환.
  //   TikTok 은 오디오 전용 스트림을 제공하지 않으므로(모든 포맷이 muxed) 영상만 지원.
  //   주의: TikTok 은 vcodec 을 'avc1...' 이 아니라 'h264' 로 보고하므로 두 표기 모두 필터.
  const VIDEO_FMT = 'best[ext=mp4][vcodec^=avc][acodec!=none]/best[ext=mp4][vcodec^=h264][acodec!=none]/best[ext=mp4][vcodec!=none][acodec!=none]/best[ext=mp4]/best';

  function isValidTiktokUrl(url) {
    return /tiktok\.com/.test(url || '');
  }

  // URL 정규화: TikTok 영상 ID 는 항상 19자리.
  // 입력 텍스트에서 ID 뒤에 여분 숫자가 붙는 경우가 있어(존재하지 않는 영상이 됨)
  // 사용자명 + 19자리 ID 만 뽑아 정규 URL 로 재구성한다.
  // vm/vt 단축 링크 등 표준형이 아니면 원본을 그대로 반환.
  function normalizeTiktokUrl(url) {
    const m = (url || '').match(/tiktok\.com\/(@[\w.-]+)\/video\/(\d{19})/);
    if (m) return `https://www.tiktok.com/${m[1]}/video/${m[2]}`;
    return url;
  }

  // 비디오 ID 추출 (파일명용) — 19자리만
  function extractVideoId(url) {
    const m = (url || '').match(/\/video\/(\d{19})/);
    return m ? m[1] : 'tiktok';
  }

  // ════════════════════════════════════════════════
  //  단일 URL 다운로드 (메타 조회 생략 — 바로 /stream)
  // ════════════════════════════════════════════════

  async function startDownload() {
    const rawUrl = document.getElementById('ttUrlInput').value.trim();

    if (!rawUrl) {
      showStatus(STATUS_PREFIX, 'TikTok 링크를 입력해주세요.', 'error');
      return;
    }
    if (!isValidTiktokUrl(rawUrl)) {
      showStatus(STATUS_PREFIX, '올바른 TikTok URL을 입력해주세요. (예: https://www.tiktok.com/@user/video/...)', 'error');
      return;
    }

    const url = normalizeTiktokUrl(rawUrl);
    const vid = extractVideoId(url);

    const btn = document.getElementById('ttDownloadBtn');
    btn.disabled = true;

    const container = document.getElementById('ttResults');
    container.innerHTML = '';

    showStatus(STATUS_PREFIX,
      '<span class="spinner"></span> 영상 다운로드 준비 중...',
      'loading'
    );

    const qs = [
      `igurl=${encodeURIComponent(url)}`,
      `idx=1`,
      `fmt=${encodeURIComponent(VIDEO_FMT)}`,
      `ext=mp4`,
      `fn=${encodeURIComponent('tiktok_' + vid)}`,
      `dl=1`,
    ].join('&');
    const dlUrl = `${BACKEND}/stream?${qs}`;

    const card = document.createElement('div');
    card.className = 'media-item';
    card.innerHTML = `
      <div class="media-info">
        <div class="media-icon video">🎬</div>
        <div>
          <div class="media-label">TikTok 영상</div>
          <div class="media-quality">워터마크 없음</div>
        </div>
      </div>
      <a href="${dlUrl}" class="btn-dl" download="tiktok_${vid}.mp4">
        ⬇ 다운로드
      </a>
    `;
    container.appendChild(card);

    const anchor = card.querySelector('a.btn-dl');
    setTimeout(() => {
      anchor.click();
      showStatus(STATUS_PREFIX,
        '다운로드가 시작됩니다. 속도가 느리면 브라우저 다운로드 목록에서 진행상황을 확인하세요.',
        ''
      );
      btn.disabled = false;
    }, 300);
  }

  // ════════════════════════════════════════════════
  //  일괄 다운로드 (Instagram 식)
  // ════════════════════════════════════════════════

  function extractUrls() {
    const text  = document.getElementById('ttBulkText').value;
    const found = [...new Set((text.match(TT_URL_RE) || []).map(normalizeTiktokUrl))];

    const listEl  = document.getElementById('ttUrlList');
    const itemsEl = document.getElementById('ttUrlListItems');
    const titleEl = document.getElementById('ttUrlListTitle');

    itemsEl.innerHTML = '';

    if (found.length === 0) {
      listEl.style.display = 'block';
      titleEl.textContent  = 'TikTok URL을 찾지 못했습니다.';
      document.getElementById('ttBulkDlBtn').disabled = true;
      return;
    }

    found.forEach((url, i) => {
      const id   = `tt_url_cb_${i}`;
      const item = document.createElement('div');
      item.className   = 'url-item';
      item.dataset.url = url;
      item.innerHTML   = `
        <input type="checkbox" id="${id}" value="${url}" checked>
        <label for="${id}">${url}</label>
        <span class="url-status" id="tt_status_${i}"></span>
      `;
      itemsEl.appendChild(item);
    });

    titleEl.textContent = `${found.length}개 URL 발견`;
    document.getElementById('ttBulkDlBtn').disabled = false;
    listEl.style.display = 'block';
  }

  function clearBulk() {
    document.getElementById('ttBulkText').value          = '';
    document.getElementById('ttUrlList').style.display    = 'none';
    document.getElementById('ttUrlListItems').innerHTML   = '';
    document.getElementById('ttBulkProgress').textContent = '';
  }

  function toggleAll() {
    const boxes      = document.querySelectorAll('#ttUrlListItems input[type="checkbox"]');
    const allChecked = [...boxes].every(b => b.checked);
    boxes.forEach(b => b.checked = !allChecked);
  }

  async function bulkDownload() {
    const checked = [...document.querySelectorAll('#ttUrlListItems input[type="checkbox"]:checked')];
    if (!checked.length) {
      alert('다운로드할 URL을 선택해주세요.');
      return;
    }

    const btn      = document.getElementById('ttBulkDlBtn');
    const progress = document.getElementById('ttBulkProgress');
    btn.disabled   = true;

    const items     = document.querySelectorAll('#ttUrlListItems .url-item');
    const statusMap = {};
    items.forEach((el, i) => {
      statusMap[el.dataset.url] = document.getElementById(`tt_status_${i}`);
    });

    const fmt   = VIDEO_FMT;
    let   done  = 0;
    const total = checked.length;

    for (const cb of checked) {
      const url      = cb.value;
      const statusEl = statusMap[url];
      const vid      = extractVideoId(url);
      progress.textContent = `처리 중 ${done + 1} / ${total}`;
      if (statusEl) { statusEl.textContent = '⏳'; statusEl.className = 'url-status loading'; }

      try {
        const qs = [
          `igurl=${encodeURIComponent(url)}`,
          `idx=1`,
          `fmt=${encodeURIComponent(fmt)}`,
          `ext=mp4`,
          `fn=${encodeURIComponent('tiktok_' + vid)}`,
          `dl=1`,
        ].join('&');
        const dlUrl  = `${BACKEND}/stream?${qs}`;
        const anchor = document.createElement('a');
        anchor.href     = dlUrl;
        anchor.download = `tiktok_${vid}.mp4`;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);

        if (statusEl) { statusEl.textContent = '✅ 완료'; statusEl.className = 'url-status done'; }
      } catch (e) {
        console.error('[tt-bulk]', url, e.message);
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
    document.getElementById('ttDownloadBtn').addEventListener('click', startDownload);
    document.getElementById('ttPasteBtn')   .addEventListener('click', () => pasteToInput('ttUrlInput', STATUS_PREFIX));
    document.getElementById('ttUrlInput')   .addEventListener('keydown', e => {
      if (e.key === 'Enter') startDownload();
    });

    document.getElementById('ttExtractBtn')  .addEventListener('click', extractUrls);
    document.getElementById('ttClearBtn')     .addEventListener('click', clearBulk);
    document.getElementById('ttToggleAllBtn') .addEventListener('click', toggleAll);
    document.getElementById('ttBulkDlBtn')    .addEventListener('click', bulkDownload);
    document.getElementById('ttBulkText')     .addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.ctrlKey) extractUrls();
    });
  });

})();

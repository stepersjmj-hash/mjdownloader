// ════════════════════════════════════════════════
//  app_youtube.js — YouTube 플랫폼 모듈
//  의존: app.js (BACKEND, showStatus, hideStatus, pasteToInput, ...)
// ════════════════════════════════════════════════

(function() {
  'use strict';

  const STATUS_PREFIX = 'yt';

  // YouTube URL 추출 정규식 (watch, youtu.be, shorts)
  const YT_URL_RE = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]+)/;

  // 품질별 yt-dlp 포맷 문자열
  //   - 360p는 ffmpeg 없이 가능 (muxed 포맷)
  //   - 720p 이상은 bv+ba 분리 → ffmpeg로 merge 필요
  //   - audio 는 m4a 네이티브
  const QUALITY_MAP = {
    '360':   'best[height<=360][ext=mp4][vcodec!=none][acodec!=none]/best[height<=360]',
    '720':   'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]',
    '1080':  'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]',
    'best':  'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    'audio': 'bestaudio[ext=m4a]/bestaudio',
  };

  const QUALITY_LABEL = {
    '360':   '360p',
    '720':   '720p',
    '1080':  '1080p',
    'best':  'Best',
    'audio': 'Audio (m4a)',
  };

  function isValidYoutubeUrl(url) {
    if (!url) return false;
    return /youtube\.com|youtu\.be/.test(url);
  }

  // 비디오 ID 추출 (파일명용)
  function extractVideoId(url) {
    const m = url.match(YT_URL_RE);
    return m ? m[1] : 'video';
  }

  // ════════════════════════════════════════════════
  //  단일 URL 다운로드
  //  YouTube 는 메타 조회(/api/convert) 생략 — 바로 /stream 호출로 충분.
  //  (메타가 필요한 경우는 플레이리스트/다중 미디어인데, MVP 범위 밖)
  // ════════════════════════════════════════════════

  async function startDownload() {
    const input   = document.getElementById('ytUrlInput');
    const url     = input.value.trim();
    const quality = document.getElementById('ytQuality').value;

    if (!url) {
      showStatus(STATUS_PREFIX, 'YouTube 링크를 입력해주세요.', 'error');
      return;
    }
    if (!isValidYoutubeUrl(url)) {
      showStatus(STATUS_PREFIX, '올바른 YouTube URL을 입력해주세요. (watch, shorts, youtu.be 지원)', 'error');
      return;
    }

    const fmt = QUALITY_MAP[quality];
    const ext = quality === 'audio' ? 'm4a' : 'mp4';
    const vid = extractVideoId(url);

    const btn = document.getElementById('ytDownloadBtn');
    btn.disabled = true;

    const container = document.getElementById('ytResults');
    container.innerHTML = '';

    showStatus(STATUS_PREFIX,
      `<span class="spinner"></span> ${QUALITY_LABEL[quality]} 다운로드 준비 중... ` +
      (quality === '360' || quality === 'audio'
        ? '(빠름)'
        : '(영상+음성 병합에 시간이 걸립니다. 1~3분 소요)'),
      'loading'
    );

    // 직접 <a> 클릭으로 다운로드 트리거
    const qs = [
      `igurl=${encodeURIComponent(url)}`,
      `idx=1`,
      `fmt=${encodeURIComponent(fmt)}`,
      `ext=${ext}`,
      `fn=${encodeURIComponent('youtube_' + vid)}`,
      `dl=1`,
    ].join('&');
    const dlUrl = `${BACKEND}/stream?${qs}`;

    // 결과 영역에 링크 카드 표시
    const card = document.createElement('div');
    card.className = 'media-item';
    card.innerHTML = `
      <div class="media-info">
        <div class="media-icon video">${quality === 'audio' ? '🎵' : '🎬'}</div>
        <div>
          <div class="media-label">YouTube ${quality === 'audio' ? '오디오' : '영상'}</div>
          <div class="media-quality">${QUALITY_LABEL[quality]}</div>
        </div>
      </div>
      <a href="${dlUrl}" class="btn-dl" download="youtube_${vid}_${quality}.${ext}">
        ⬇ 다운로드
      </a>
    `;
    container.appendChild(card);

    // 링크 클릭을 자동 트리거
    const anchor = card.querySelector('a.btn-dl');
    setTimeout(() => {
      anchor.click();
      hideStatus(STATUS_PREFIX);
      showStatus(STATUS_PREFIX,
        '다운로드가 시작됩니다. 속도가 느리면 브라우저 다운로드 목록에서 진행상황을 확인하세요.',
        ''
      );
      btn.disabled = false;
    }, 300);
  }

  // ════════════════════════════════════════════════
  //  이벤트 바인딩
  // ════════════════════════════════════════════════

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('ytDownloadBtn').addEventListener('click', startDownload);
    document.getElementById('ytPasteBtn')   .addEventListener('click', () => pasteToInput('ytUrlInput', STATUS_PREFIX));
    document.getElementById('ytUrlInput')   .addEventListener('keydown', e => {
      if (e.key === 'Enter') startDownload();
    });
  });

})();

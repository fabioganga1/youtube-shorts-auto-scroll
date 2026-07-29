// ==UserScript==
// @name         YouTube Shorts Auto Scroll
// @namespace    https://github.com/fabioganga1
// @version      1.0.2
// @description  Avança automaticamente para o próximo Short quando o vídeo termina (auto-scroll no YouTube Shorts)
// @description:en  Automatically advances to the next Short when the video ends (auto-scroll for YouTube Shorts)
// @author       fabioganga1
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/fabioganga1/youtube-shorts-auto-scroll/main/youtube-shorts-auto-scroll.user.js
// @downloadURL  https://raw.githubusercontent.com/fabioganga1/youtube-shorts-auto-scroll/main/youtube-shorts-auto-scroll.user.js
// ==/UserScript==

(function () {
  'use strict';

  let enabled = GM_getValue('enabled', true);
  let currentVideo = null;
  let lastAdvanceAt = 0;
  let suppressUntil = 0;   // janela em que NÃO se avança (resize/fullscreen)
  let lastTime = -1;       // último currentTime visto (continuidade de reprodução)

  // Ao redimensionar a janela ou entrar/sair de fullscreen, o YouTube
  // recarrega o vídeo noutra qualidade e o currentTime/duration ficam num
  // estado transitório que parece "fim do vídeo" — suprimimos avanços
  // durante uns instantes para não saltar Shorts sem querer.
  function suppress() {
    suppressUntil = Date.now() + 2000;
  }
  window.addEventListener('resize', suppress);
  document.addEventListener('fullscreenchange', suppress);

  GM_registerMenuCommand('Ativar / Desativar auto-scroll', () => {
    enabled = !enabled;
    GM_setValue('enabled', enabled);
    showToast(enabled ? '▶ Auto-scroll ATIVADO' : '⏸ Auto-scroll DESATIVADO');
  });

  function isShortsPage() {
    return location.pathname.startsWith('/shorts/');
  }

  // Avança para o próximo Short. Tenta o botão de navegação do próprio
  // YouTube (desktop); se não existir (mobile / layout novo), faz scroll
  // no contentor dos reels.
  function nextShort() {
    const now = Date.now();
    if (now < suppressUntil) return;        // resize/fullscreen recente
    if (now - lastAdvanceAt < 1500) return; // evita duplo avanço
    lastAdvanceAt = now;

    const downBtn = document.querySelector('#navigation-button-down button, [aria-label="Next video"], [aria-label="Vídeo seguinte"]');
    if (downBtn) {
      downBtn.click();
      return;
    }

    // Fallback: scroll do contentor de reels (um ecrã para baixo)
    const reel = document.querySelector('#shorts-container, ytd-shorts');
    if (reel) {
      reel.scrollBy({ top: window.innerHeight, behavior: 'smooth' });
    }
  }

  function onEnded() {
    if (enabled && isShortsPage()) nextShort();
  }

  // Com loop ativo o evento "ended" não dispara, por isso vigiamos também
  // o timeupdate e avançamos mesmo antes do fim. Só avançamos se o fim foi
  // atingido por reprodução contínua (delta pequeno e positivo) — durante
  // um resize/troca de qualidade o currentTime dá saltos e ignoramos.
  function onTimeUpdate(e) {
    if (!enabled || !isShortsPage()) return;
    const v = e.target;
    const t = v.currentTime;
    const delta = t - lastTime;
    lastTime = t;
    if (!v.duration || v.duration < 1 || v.seeking) return;
    if (t >= v.duration - 0.15 && delta > 0 && delta < 1) {
      nextShort();
    }
  }

  function hookVideo() {
    if (!isShortsPage()) return;

    const video = document.querySelector('ytd-shorts video, #shorts-player video, video');
    if (!video || video === currentVideo) {
      if (video) {
        video.loop = false; // o YouTube volta a pôr loop=true
        // Se o "ended" caiu dentro da janela de supressão (resize),
        // o vídeo fica parado no fim — e após a troca de qualidade a
        // flag "ended" pode perder-se, por isso também consideramos
        // "pausado mesmo no fim" como terminado.
        const stuckAtEnd = video.paused && video.duration > 1 &&
          video.currentTime >= video.duration - 0.2;
        if (enabled && (video.ended || stuckAtEnd)) nextShort();
      }
      return;
    }

    if (currentVideo) {
      currentVideo.removeEventListener('ended', onEnded);
      currentVideo.removeEventListener('timeupdate', onTimeUpdate);
    }

    currentVideo = video;
    lastTime = -1;
    video.loop = false;
    video.addEventListener('ended', onEnded);
    video.addEventListener('timeupdate', onTimeUpdate);
  }

  function showToast(text) {
    const t = document.createElement('div');
    t.textContent = text;
    Object.assign(t.style, {
      position: 'fixed', bottom: '24px', left: '50%',
      transform: 'translateX(-50%)', zIndex: 999999,
      background: 'rgba(0,0,0,.85)', color: '#fff',
      padding: '10px 18px', borderRadius: '8px',
      font: '14px/1.4 Roboto, Arial, sans-serif',
      pointerEvents: 'none', transition: 'opacity .4s',
    });
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; }, 1800);
    setTimeout(() => t.remove(), 2300);
  }

  // O YouTube é uma SPA: o vídeo troca sem recarregar a página,
  // por isso verificamos periodicamente qual é o vídeo ativo.
  setInterval(hookVideo, 500);
  document.addEventListener('yt-navigate-finish', hookVideo);
})();

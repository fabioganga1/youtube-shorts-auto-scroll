// ==UserScript==
// @name         YouTube Shorts Auto Scroll
// @namespace    https://github.com/fabioganga1
// @version      1.2.0
// @description  Avança automaticamente para o próximo Short quando o vídeo termina (auto-scroll no YouTube Shorts)
// @description:en  Automatically advances to the next Short when the video ends (auto-scroll for YouTube Shorts)
// @author       fabioganga1
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/fabioganga1/youtube-shorts-auto-scroll/main/youtube-shorts-auto-scroll.user.js
// @downloadURL  https://raw.githubusercontent.com/fabioganga1/youtube-shorts-auto-scroll/main/youtube-shorts-auto-scroll.user.js
// ==/UserScript==

// Para desativar o auto-scroll, desliga o script no próprio Tampermonkey.

(function () {
  'use strict';

  let currentVideo = null;
  let lastAdvanceAt = 0;
  let suppressUntil = 0;      // janela em que NÃO se avança (resize/fullscreen)
  let pendingAdvance = false; // avanço adiado pela janela de supressão
  let lastTime = -1;          // último currentTime visto (continuidade de reprodução)
  let lastPath = location.pathname;

  const lockedVideos = new WeakSet();

  // Ao redimensionar a janela ou entrar/sair de fullscreen, o YouTube
  // recarrega o vídeo noutra qualidade e o currentTime/duration ficam num
  // estado transitório que parece "fim do vídeo" — suprimimos avanços
  // durante uns instantes para não saltar Shorts sem querer.
  function suppress() {
    suppressUntil = Date.now() + 2000;
  }
  window.addEventListener('resize', suppress);
  document.addEventListener('fullscreenchange', suppress);

  function isShortsPage() {
    return location.pathname.startsWith('/shorts/');
  }

  // O YouTube religa loop=true a toda a hora (seeks, trocas de qualidade),
  // e com loop ativo o vídeo dá a volta SEM disparar "ended". Trancamos a
  // propriedade: limpamos o estado nativo via setter do protótipo e
  // bloqueamos escritas futuras — assim o "ended" dispara sempre.
  function lockLoop(v) {
    if (lockedVideos.has(v)) return;
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'loop');
      desc.set.call(v, false);
      v.removeAttribute('loop');
      Object.defineProperty(v, 'loop', {
        get: () => false,
        set: () => {},
        configurable: true,
      });
      lockedVideos.add(v);
    } catch (e) {
      v.loop = false; // fallback: pelo menos desligar agora
    }
  }

  // Avança para o próximo Short. Tenta o botão de navegação do próprio
  // YouTube (desktop); se não existir (mobile / layout novo), faz scroll
  // no contentor dos reels.
  function nextShort() {
    const now = Date.now();
    if (now < suppressUntil) {
      // fim do vídeo apanhou a janela pós-resize: fica pendente e o
      // verificador periódico dispara-o assim que a janela expirar.
      pendingAdvance = true;
      return;
    }
    if (now - lastAdvanceAt < 1500) return; // evita duplo avanço
    pendingAdvance = false;
    lastAdvanceAt = now;

    // 1) Botão nativo "vídeo seguinte", se estiver visível.
    const downBtn = document.querySelector('#navigation-button-down button, [aria-label="Next video"], [aria-label="Vídeo seguinte"]');
    if (downBtn && downBtn.offsetParent !== null) {
      downBtn.click();
      return;
    }

    // 2) Método interno do componente ytd-shorts (funciona mesmo com o
    //    botão escondido em janelas estreitas). @grant none corre no
    //    contexto da página, por isso temos acesso direto.
    const shorts = document.querySelector('ytd-shorts');
    if (shorts && typeof shorts.handleNextButtonClick === 'function') {
      try { shorts.handleNextButtonClick(); return; } catch (e) { /* segue */ }
    }

    // 3) Clique no botão mesmo escondido (alguns layouts aceitam).
    if (downBtn) {
      downBtn.click();
      return;
    }

    // 4) Último recurso: scroll do contentor de reels.
    const reel = document.querySelector('#shorts-container, ytd-shorts');
    if (reel) {
      reel.scrollBy({ top: window.innerHeight, behavior: 'smooth' });
    }
  }

  function onEnded() {
    if (isShortsPage()) nextShort();
  }

  // Rede de segurança: com o loop trancado o "ended" é o caminho normal,
  // mas se um tick de timeupdate cair mesmo em cima do fim avançamos já.
  // Só com reprodução contínua (delta pequeno e positivo) — durante um
  // resize/troca de qualidade o currentTime dá saltos e ignoramos.
  function onTimeUpdate(e) {
    if (!isShortsPage()) return;
    const v = e.target;
    const t = v.currentTime;
    const delta = t - lastTime;
    lastTime = t;
    if (!v.duration || v.duration < 1 || v.seeking) return;
    if (t >= v.duration - 0.35 && delta > 0 && delta < 1) {
      nextShort();
    }
  }

  function tick() {
    // Navegou para outro Short (manual ou automático): estado limpo.
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      pendingAdvance = false;
      lastTime = -1;
    }

    if (!isShortsPage()) return;

    // Avanço que ficou pendente durante a janela pós-resize.
    if (pendingAdvance && Date.now() >= suppressUntil) {
      nextShort();
    }

    const video = document.querySelector('ytd-shorts video, #shorts-player video, video');
    if (!video) return;

    lockLoop(video);
    // O YouTube pode contornar a tranca via setAttribute('loop').
    if (video.hasAttribute('loop')) video.removeAttribute('loop');

    if (video === currentVideo) {
      // Se o "ended" se perdeu (recarregamento de qualidade em cima do
      // fim), o vídeo fica parado no fim — apanhamos aqui esse caso.
      const stuckAtEnd = video.paused && !video.seeking &&
        video.readyState >= 2 && video.duration > 1 &&
        video.currentTime >= video.duration - 0.2;
      if (video.ended || stuckAtEnd) nextShort();
      return;
    }

    if (currentVideo) {
      currentVideo.removeEventListener('ended', onEnded);
      currentVideo.removeEventListener('timeupdate', onTimeUpdate);
    }

    currentVideo = video;
    lastTime = -1;
    video.addEventListener('ended', onEnded);
    video.addEventListener('timeupdate', onTimeUpdate);
  }

  // O YouTube é uma SPA: o vídeo troca sem recarregar a página,
  // por isso verificamos periodicamente qual é o vídeo ativo.
  setInterval(tick, 500);
  document.addEventListener('yt-navigate-finish', tick);
})();

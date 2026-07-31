// ==UserScript==
// @name         YouTube Shorts Auto Scroll
// @namespace    https://github.com/fabioganga1
// @version      1.4.0
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
//
// Invariante central: SÓ se avança para o próximo Short se o utilizador
// viu mesmo este até (perto d)o fim — medido por reprodução contínua
// acumulada (maxPlayed). Resizes, fullscreen, trocas de qualidade e flags
// sujas geram sinais falsos de "fim", mas nunca conseguem falsificar a
// reprodução contínua, por isso nunca causam avanços indevidos.

(function () {
  'use strict';

  let currentVideo = null;
  let lastAdvanceAt = 0;
  let suppressUntil = 0;      // janela pós-resize/fullscreen: não avançar já
  let pendingAdvance = false; // avanço genuíno adiado pela janela acima
  let lastTime = -1;          // último currentTime visto (para medir deltas)
  let lastPath = location.pathname;

  // Estado por Short (reposto quando o URL muda)
  let maxPlayed = 0;       // ponto mais avançado atingido em reprodução CONTÍNUA
  let stableDuration = 0;  // duração TRANCADA após leituras consistentes
  let durSamples = [];     // leituras de duração à espera de confirmação

  const lockedVideos = new WeakSet();

  // Ao redimensionar/alternar fullscreen, o YouTube recarrega o vídeo
  // noutra qualidade — não avançamos durante esses instantes.
  function suppress() {
    suppressUntil = Date.now() + 2000;
  }
  window.addEventListener('resize', suppress);
  document.addEventListener('fullscreenchange', suppress);

  function isShortsPage() {
    return location.pathname.startsWith('/shorts/');
  }

  function resetShortState() {
    maxPlayed = 0;
    stableDuration = 0;
    durSamples = [];
    lastTime = -1;
    pendingAdvance = false;
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

  // Verdade fundamental: o utilizador viu este Short até (perto d)o fim?
  // Só a reprodução contínua consegue satisfazer isto — nenhum sinal
  // transitório de resize/reload o falsifica.
  function watchedToEnd() {
    return stableDuration > 0 && maxPlayed >= stableDuration - 1.5;
  }

  // Avança para o próximo Short (só chamado depois de watchedToEnd()).
  function nextShort() {
    const now = Date.now();
    if (now < suppressUntil) {
      // fim genuíno em plena janela pós-resize: fica pendente e o
      // verificador periódico dispara-o quando a janela expirar.
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
    if (isShortsPage() && watchedToEnd()) nextShort();
  }

  // Mede a reprodução contínua. Deltas anormais (seek, reload de
  // qualidade, troca de vídeo) são ignorados — só o avanço natural do
  // relógio de reprodução conta para maxPlayed/stableDuration.
  function onTimeUpdate(e) {
    const v = e.target;
    const t = v.currentTime;
    const delta = t - lastTime;
    lastTime = t;
    if (!isShortsPage() || v.seeking) return;
    if (delta <= 0 || delta >= 1) return; // salto: não é reprodução contínua

    // A duração só é aceite após 3 leituras consecutivas concordantes em
    // reprodução contínua, e depois fica TRANCADA para este Short. Durante
    // reloads de qualidade o YouTube pode reportar durações transitórias
    // (ex.: encolhida até à posição atual) que validariam um falso "fim".
    if (!stableDuration && v.duration && isFinite(v.duration) && v.duration > 1) {
      durSamples.push(v.duration);
      if (durSamples.length > 3) durSamples.shift();
      if (durSamples.length === 3 &&
          Math.max(...durSamples) - Math.min(...durSamples) < 0.5) {
        stableDuration = Math.max(...durSamples);
      }
    }

    if (t > maxPlayed) maxPlayed = t;
    if (stableDuration && t >= stableDuration - 0.35 && watchedToEnd()) {
      nextShort();
    }
  }

  // Rebobinar exige voltar a ver até ao fim (senão, um sinal falso após
  // um rewind podia reaproveitar um maxPlayed antigo).
  function onSeeked(e) {
    maxPlayed = Math.min(maxPlayed, e.target.currentTime);
  }

  function tick() {
    // Navegou para outro Short (manual ou automático): estado limpo.
    // Isto também mata avanços em cadeia: a flag "ended" suja que fica
    // no elemento reutilizado nunca passa em watchedToEnd() (maxPlayed=0).
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      resetShortState();
    }

    if (!isShortsPage()) return;

    // Avanço genuíno que ficou pendente durante a janela pós-resize.
    if (pendingAdvance && Date.now() >= suppressUntil) {
      nextShort();
    }

    const video = document.querySelector('ytd-shorts video, #shorts-player video, video');
    if (!video) return;

    lockLoop(video);
    // O YouTube pode contornar a tranca via setAttribute('loop').
    if (video.hasAttribute('loop')) video.removeAttribute('loop');

    if (video === currentVideo) {
      // Fim que o "ended" perdeu (reload de qualidade em cima do fim
      // deixa o vídeo pausado no fim sem flag). stableDuration em vez da
      // duration ao vivo: valores transitórios do reload não contam.
      const stuck = video.paused && !video.seeking && video.readyState >= 2 &&
        stableDuration > 0 && video.currentTime >= stableDuration - 0.3;
      if ((video.ended || stuck) && watchedToEnd()) nextShort();
      return;
    }

    if (currentVideo) {
      currentVideo.removeEventListener('ended', onEnded);
      currentVideo.removeEventListener('timeupdate', onTimeUpdate);
      currentVideo.removeEventListener('seeked', onSeeked);
    }

    currentVideo = video;
    lastTime = -1;
    video.addEventListener('ended', onEnded);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('seeked', onSeeked);
  }

  // O YouTube é uma SPA: o vídeo troca sem recarregar a página,
  // por isso verificamos periodicamente qual é o vídeo ativo.
  setInterval(tick, 500);
  document.addEventListener('yt-navigate-finish', tick);
})();

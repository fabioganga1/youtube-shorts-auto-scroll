// ==UserScript==
// @name         YouTube Shorts Auto Scroll
// @namespace    https://github.com/fabioganga1
// @version      1.5.0
// @description  Avança automaticamente para o próximo Short quando o vídeo termina (auto-scroll no YouTube Shorts)
// @description:en  Automatically advances to the next Short when the video ends (auto-scroll for YouTube Shorts)
// @author       fabioganga1
// @match        https://www.youtube.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/fabioganga1/youtube-shorts-auto-scroll/main/youtube-shorts-auto-scroll.user.js
// @downloadURL  https://raw.githubusercontent.com/fabioganga1/youtube-shorts-auto-scroll/main/youtube-shorts-auto-scroll.user.js
// ==/UserScript==

// Para desativar o auto-scroll, desliga o script no próprio Tampermonkey.
// Apenas YouTube desktop: no m.youtube.com não existem os mecanismos de
// navegação usados aqui, e trancar o loop lá deixaria o Short congelado.
//
// Invariante central: SÓ se avança se o utilizador viu mesmo ESTE Short até
// (perto d)o fim — medido por reprodução contínua acumulada (maxPlayed),
// validada contra uma duração TRANCADA só depois de calibrada com leituras
// concordantes fora de janelas de resize. Sinais transitórios (reloads de
// qualidade, flags sujas do elemento reutilizado, durações falsas) não
// conseguem falsificar reprodução contínua nem envenenar a calibração.

(function () {
  'use strict';

  let currentVideo = null;
  let lastAdvanceAt = 0;
  let suppressUntil = 0;      // janela pós-resize/fullscreen: não avançar já
  let pendingAdvance = false; // avanço genuíno adiado pela janela acima
  let lastTime = -1;          // último currentTime visto (para medir deltas)
  let lastPath = location.pathname;

  // Estado por Short (reposto quando o URL muda)
  let maxPlayed = 0;           // ponto mais avançado em reprodução CONTÍNUA
  let stableDuration = 0;      // duração TRANCADA após calibração
  let durSamples = [];         // amostras de duração à espera de confirmação
  let firstSampleAt = 0;       // media-time da 1.ª amostra (exigir extensão)
  let mediaConfirmed = true;   // já há prova de que o <video> toca ESTE Short
  let provisionalEndedAt = 0;  // "ended" à espera de confirmação por persistência

  const lockedVideos = new WeakSet();

  // Ao redimensionar/alternar fullscreen, o YouTube recarrega o vídeo
  // noutra qualidade — não avançamos nem CALIBRAMOS durante esses instantes
  // (as durações reportadas no reload não são de confiança).
  function suppress() {
    suppressUntil = Date.now() + 2000;
    if (!stableDuration) { durSamples = []; firstSampleAt = 0; }
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
    firstSampleAt = 0;
    lastTime = -1;
    pendingAdvance = false;
    provisionalEndedAt = 0;
    // O YouTube REUTILIZA o mesmo <video> entre Shorts: depois de mudar o
    // URL, a cauda do Short anterior ainda toca neste elemento. Até haver
    // prova de que o media trocou (loadstart/durationchange/emptied, ou
    // currentTime perto do início), ignoramos tudo o que ele emite.
    mediaConfirmed = false;
  }

  function onMediaSwap() {
    mediaConfirmed = true;
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
  function watchedToEnd() {
    return stableDuration > 0 && maxPlayed >= stableDuration - 1.5;
  }

  // Avança para o próximo Short (só chamado depois dos guardas de estado).
  function nextShort() {
    const now = Date.now();
    if (now < suppressUntil) {
      // fim genuíno em plena janela pós-resize: fica pendente e o
      // verificador periódico revalida e dispara quando a janela expirar.
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
    if (!isShortsPage() || !mediaConfirmed) return;
    if (watchedToEnd()) nextShort();
    // Sem duração trancada (Short muito curto, seek cedo para o fim,
    // calibração adiada por resizes): não ignorar o fim genuíno — fica
    // provisório e o tick confirma-o por persistência (um "ended" falso
    // de reload não sobrevive: o YouTube retoma a reprodução).
    else if (!stableDuration && !provisionalEndedAt) {
      provisionalEndedAt = Date.now();
    }
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

    // Quarentena pós-navegação: só aceitar eventos deste elemento quando
    // for claramente o Short novo (arranque perto do início).
    if (!mediaConfirmed) {
      if (t < 2) mediaConfirmed = true;
      else return;
    }

    if (delta <= 0 || delta >= 1) return; // salto: não é reprodução contínua

    // Calibração da duração — todas as condições em simultâneo:
    //  - fora da janela pós-resize (reloads mentem sobre a duração);
    //  - duração folgadamente à frente da posição (uma duração "encolhida
    //    até à posição atual" é o transitório clássico do reload);
    //  - 3+ leituras concordantes espalhadas por >=1.2s de reprodução.
    // Depois de trancada, fica trancada para este Short.
    if (!stableDuration && Date.now() >= suppressUntil &&
        v.duration && isFinite(v.duration) && v.duration > 1 &&
        v.duration > t + Math.min(2, v.duration / 2)) {
      if (durSamples.length === 0) firstSampleAt = t;
      durSamples.push(v.duration);
      if (durSamples.length > 3) durSamples.shift();
      if (durSamples.length === 3 &&
          Math.max(...durSamples) - Math.min(...durSamples) < 0.5 &&
          t - firstSampleAt >= 1.2) {
        stableDuration = Math.max(...durSamples);
      }
    }

    // Autocorreção: se a reprodução contínua ultrapassar a duração
    // trancada, a tranca era falsa — recalibrar do zero.
    if (stableDuration && t > stableDuration + 0.75) {
      stableDuration = 0;
      durSamples = [];
      firstSampleAt = 0;
      pendingAdvance = false;
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
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      resetShortState();
    }

    if (!isShortsPage()) return;

    // Avanço que ficou pendente durante a janela pós-resize — REVALIDADO
    // no momento do disparo (um rewind entretanto cancela-o).
    if (pendingAdvance && Date.now() >= suppressUntil) {
      pendingAdvance = false;
      if (watchedToEnd()) nextShort();
    }

    // Seletores com prioridade REAL (uma lista única de querySelector
    // devolveria o primeiro <video> do documento — p.ex. o do /watch que
    // o YouTube mantém escondido no DOM). Nunca aceitar um <video> solto.
    const video = document.querySelector('ytd-shorts video') ||
                  document.querySelector('#shorts-player video');
    if (!video) return;

    lockLoop(video);
    // O YouTube pode contornar a tranca via setAttribute('loop').
    if (video.hasAttribute('loop')) video.removeAttribute('loop');

    if (video === currentVideo) {
      if (!mediaConfirmed) return; // cauda do Short anterior: ignorar

      // Fim que o "ended" perdeu (reload em cima do fim deixa o vídeo
      // pausado no fim sem flag). stableDuration em vez da duration ao
      // vivo: valores transitórios do reload não contam.
      const stuck = video.paused && !video.seeking && video.readyState >= 2 &&
        stableDuration > 0 && video.currentTime >= stableDuration - 0.3;
      if ((video.ended || stuck) && watchedToEnd()) {
        nextShort();
        return;
      }

      // Fim provisório (sem duração trancada): confirmar por persistência.
      // Se um "ended" sobrevive >=1.2s com o vídeo parado, é um fim real —
      // um transitório de reload teria retomado a reprodução entretanto.
      if (!stableDuration && video.ended) {
        const now = Date.now();
        if (!provisionalEndedAt) {
          provisionalEndedAt = now;
        } else if (now - provisionalEndedAt >= 1200 && now >= suppressUntil) {
          nextShort();
        }
      } else if (provisionalEndedAt && !video.ended) {
        provisionalEndedAt = 0; // retomou: era transitório
      }
      return;
    }

    if (currentVideo) {
      currentVideo.removeEventListener('ended', onEnded);
      currentVideo.removeEventListener('timeupdate', onTimeUpdate);
      currentVideo.removeEventListener('seeked', onSeeked);
      currentVideo.removeEventListener('loadstart', onMediaSwap);
      currentVideo.removeEventListener('durationchange', onMediaSwap);
      currentVideo.removeEventListener('emptied', onMediaSwap);
    }

    currentVideo = video;
    lastTime = -1;
    video.addEventListener('ended', onEnded);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('seeked', onSeeked);
    // Prova de troca de media no elemento reutilizado (fim da quarentena).
    video.addEventListener('loadstart', onMediaSwap);
    video.addEventListener('durationchange', onMediaSwap);
    video.addEventListener('emptied', onMediaSwap);
  }

  // O YouTube é uma SPA: o vídeo troca sem recarregar a página,
  // por isso verificamos periodicamente qual é o vídeo ativo.
  setInterval(tick, 500);
  document.addEventListener('yt-navigate-finish', tick);
})();

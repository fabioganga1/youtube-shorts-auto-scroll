// ==UserScript==
// @name         YouTube Shorts Auto Scroll
// @namespace    https://github.com/fabioganga1
// @version      1.10.0
// @description  Avança automaticamente para o próximo Short quando o vídeo termina (auto-scroll no YouTube Shorts)
// @description:en  Automatically advances to the next Short when the video ends (auto-scroll for YouTube Shorts)
// @author       fabioganga1
// @license      MIT
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
// Invariante central: só se avança DE IMEDIATO se o utilizador viu mesmo
// ESTE Short até (perto d)o fim — medido por reprodução CONTÍNUA acumulada
// (maxPlayed, que só cresce quando a cabeça de leitura está mesmo em cima
// dele), validada contra uma duração TRANCADA só depois de calibrada com
// leituras concordantes fora de janelas de resize. Sinais transitórios
// (reloads de qualidade, flags sujas do elemento reutilizado, durações
// falsas) não conseguem falsificar reprodução contínua nem envenenar a
// calibração.
//
// Um fim SEM esse crédito (salto para o fim, calibração adiada) não é
// ignorado — passa por confirmação por persistência, que os transitórios
// não sobrevivem. A persistência exige na mesma a ÂNCORA de reprodução
// (arranque perto de 0 ou seek real NESTE Short): sem ela, o "ended" da
// cauda do Short anterior — que continua a tocar no elemento reutilizado
// enquanto o media novo carrega — avançava em cadeia. Era o "ressalta
// para os próximos vídeos" ao redimensionar a janela, e o mesmo com rede
// lenta sem resize nenhum. Trancar o loop e depois não avançar deixaria o
// Short congelado no último frame, pior do que o comportamento nativo.
//
// Rede de segurança: se um avanço não mudar o URL (fila do YouTube sem
// próximo Short — verificado ao vivo: o clique no botão não navega porque
// não há para onde ir), NUNCA deixar o vídeo congelado no último frame.
// Devolve-se o loop nativo e retoma-se a reprodução — o Short repete como
// o YouTube faria — e tenta-se outra vez a cada passagem pelo fim. Só após
// 5 falhas seguidas é que se desiste de vez (seletores obsoletos), sempre
// com o vídeo a repetir, nunca parado.
//
// Âmbito: o @match cobre todo o youtube.com e TEM de cobrir. O Tampermonkey
// injeta na carga do documento e o YouTube entra nos Shorts por pushState;
// um @match só de /shorts/* não injeta nada quando se chega aos Shorts pela
// homepage/barra lateral (verificado na prática: era uma das causas do
// "às vezes não funciona"). A regra "desativado fora dos Shorts" é garantida
// pelo MOTOR: o intervalo de 500 ms, os listeners de resize/fullscreen, os
// listeners do <video> e a tranca do loop só existem enquanto o URL for
// /shorts/. Fora dele resta uma comparação de string de 2 em 2 segundos.

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
  let creditAnchored = false;  // maxPlayed já está ancorado nesta reprodução
  let reanchorNear = -1;       // rewind à espera de re-âncora perto do alvo
  let stableDuration = 0;      // duração TRANCADA após calibração
  let durSamples = [];         // amostras de duração à espera de confirmação
  let firstSampleAt = 0;       // media-time da 1.ª amostra (exigir extensão)
  let mediaConfirmed = true;   // já há prova de que o <video> toca ESTE Short
  let provisionalEndedAt = 0;  // "ended" à espera de confirmação por persistência

  // Vigia dos avanços (rede de segurança contra fila vazia / DOM mudado)
  let advanceAt = 0;           // tentativa de avanço por confirmar
  let failedAdvances = 0;      // tentativas seguidas que não mudaram o URL
  let stalled = false;         // a falhar: loop nativo devolvido até o URL mudar
  let disabled = false;        // desistimos: loop devolvido ao YouTube

  // Motor: só existe enquanto estivermos num /shorts/
  let engineTimer = null;
  let routeTimer = 0;
  let booted = false;          // já arrancámos alguma vez nesta página?

  const lockedVideos = new WeakSet();

  // Ao redimensionar/alternar fullscreen, o YouTube recarrega o vídeo
  // noutra qualidade — não avançamos nem CALIBRAMOS durante esses instantes
  // (as durações reportadas no reload não são de confiança). Estes listeners
  // são ligados pelo motor e desligados com ele: num vídeo normal do YouTube
  // redimensionar a janela não chega sequer a chamar isto.
  function suppress() {
    suppressUntil = Date.now() + 2000;
    if (!stableDuration) { durSamples = []; firstSampleAt = 0; }
  }

  function isShortsPage() {
    return location.pathname.startsWith('/shorts/');
  }

  function resetShortState() {
    maxPlayed = 0;
    creditAnchored = false;
    reanchorNear = -1;
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
    // Durante a janela pós-resize, loadstart/durationchange são ambíguos:
    // tanto podem ser o media novo como o reload de qualidade do conteúdo
    // ANTIGO (o resize provoca reloads). Não servem de prova nessa janela —
    // o media novo confirma-se na mesma pelo arranque (currentTime < 2).
    if (Date.now() < suppressUntil) return;
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
    } catch {
      v.loop = false; // fallback: pelo menos desligar agora
    }
  }

  // Devolve a propriedade nativa (a nossa é configurable, por isso o delete
  // repõe o acessor do protótipo). Sem isto, o elemento ficava com o loop
  // preso a false para sempre, mesmo fora dos Shorts.
  function unlockLoop(v) {
    try { delete v.loop; } catch { /* nada a fazer */ }
    lockedVideos.delete(v);
  }

  // Larga o elemento por completo: listeners fora e loop devolvido.
  function releaseVideo(v) {
    if (!v) return;
    v.removeEventListener('ended', onEnded);
    v.removeEventListener('timeupdate', onTimeUpdate);
    v.removeEventListener('seeked', onSeeked);
    v.removeEventListener('loadstart', onMediaSwap);
    v.removeEventListener('durationchange', onMediaSwap);
    v.removeEventListener('emptied', onMediaSwap);
    unlockLoop(v);
  }

  // Os fallbacks de navegação deixaram de funcionar de vez: não faz sentido
  // manter o loop trancado, porque isso deixa o Short parado no último
  // frame — um estado que o YouTube sozinho nunca produz. Repomos o loop,
  // RETOMAMOS a reprodução (um vídeo terminado não recomeça sozinho só por
  // se lhe repor o loop) e saímos de cena.
  function giveUp() {
    disabled = true;
    const v = currentVideo;
    stopEngine();
    if (routeTimer) { clearInterval(routeTimer); routeTimer = 0; }
    resumeNativeLoop(v);
    console.warn('[YT Shorts Auto Scroll] Cinco tentativas de avanço seguidas não ' +
      'mudaram o URL — fila do YouTube vazia ou seletores desatualizados. ' +
      'Devolvi o loop nativo e desliguei-me; recarrega a página para reativar.');
  }

  // Devolve o comportamento nativo AGORA: loop ligado e a tocar. Usado
  // quando um avanço falha — o pior estado possível é o vídeo congelado.
  function resumeNativeLoop(v) {
    if (!v) return;
    unlockLoop(v);
    try {
      v.loop = true;
      if (v.paused) {
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      }
    } catch { /* nada a fazer */ }
  }

  // Verdade fundamental: o utilizador viu este Short até (perto d)o fim?
  function watchedToEnd() {
    return stableDuration > 0 && maxPlayed >= stableDuration - 1.5;
  }

  // Avança para o próximo Short (só chamado depois dos guardas de estado).
  function nextShort() {
    if (disabled) return;
    const now = Date.now();
    if (now < suppressUntil) {
      // fim genuíno em plena janela pós-resize: fica pendente e o
      // verificador periódico revalida e dispara quando a janela expirar.
      pendingAdvance = true;
      return;
    }
    if (advanceAt) return;                  // tentativa anterior por confirmar
    if (now - lastAdvanceAt < 1500) return; // evita duplo avanço
    pendingAdvance = false;
    lastAdvanceAt = now;
    advanceAt = now;

    // 1) Botão nativo "vídeo seguinte", se estiver visível.
    //    Cada seletor é testado à vez: numa lista separada por vírgulas o
    //    querySelector devolveria o primeiro em ordem de DOCUMENTO, não o
    //    primeiro da lista, e a prioridade pretendida perdia-se.
    const downBtn = document.querySelector('#navigation-button-down button') ||
                    document.querySelector('[aria-label="Next video"]') ||
                    document.querySelector('[aria-label="Vídeo seguinte"]');
    if (downBtn && downBtn.offsetParent !== null) {
      downBtn.click();
      return;
    }

    // 2) Método interno do componente ytd-shorts (funciona mesmo com o
    //    botão escondido em janelas estreitas). @grant none corre no
    //    contexto da página, por isso temos acesso direto.
    const shorts = document.querySelector('ytd-shorts');
    if (shorts && typeof shorts.handleNextButtonClick === 'function') {
      try { shorts.handleNextButtonClick(); return; } catch { /* segue */ }
    }

    // 3) Clique no botão mesmo escondido (alguns layouts aceitam).
    if (downBtn) {
      downBtn.click();
      return;
    }

    // 4) Último recurso: scroll do contentor de reels (mesma ordem
    //    explícita que em 1 — o contentor interno tem prioridade).
    const reel = document.querySelector('#shorts-container') ||
                 document.querySelector('ytd-shorts');
    if (reel) {
      reel.scrollBy({ top: window.innerHeight, behavior: 'smooth' });
    }
  }

  // Posição a partir da qual um "ended" é plausível. Serve para descartar
  // "ended" absurdos (um transitório de reload a meio do vídeo) sem exigir
  // a duração trancada, que pode ainda não existir.
  function endIsPlausible(v) {
    const d = stableDuration || (Number.isFinite(v.duration) ? v.duration : 0);
    return d > 0 && v.currentTime >= d - 1.5;
  }

  function onEnded() {
    if (!isShortsPage() || !mediaConfirmed) return;
    if (watchedToEnd()) nextShort();
    // Fim sem crédito de reprodução contínua (Short muito curto, salto para
    // o fim, calibração adiada por resizes): não ignorar — fica provisório
    // e o tick confirma-o por persistência. Um "ended" falso de reload não
    // sobrevive: o YouTube retoma a reprodução.
    else if (!provisionalEndedAt) provisionalEndedAt = Date.now();
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
        v.duration && Number.isFinite(v.duration) && v.duration > 1 &&
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

    // Crédito de reprodução. maxPlayed só cresce por CONTINUIDADE: a cabeça
    // de leitura tem de estar em cima dele (a menos de um delta). Sem isto,
    // um salto para a frente ganhava crédito total no evento seguinte — o
    // lastTime é atualizado mesmo nos eventos descartados, portanto o salto
    // custava apenas um timeupdate e a invariante era só aparente.
    // A âncora só se prende num ARRANQUE genuíno (t < 2) ou na retoma de um
    // rewind real (perto do alvo pedido no onSeeked) — a cauda do Short
    // anterior, que toca alto no elemento reutilizado, nunca pode virar
    // crédito por si própria.
    if (!creditAnchored) {
      if (t < 2 || (reanchorNear >= 0 && t >= reanchorNear && t - reanchorNear < 3)) {
        creditAnchored = true;
        reanchorNear = -1;
        maxPlayed = t; // ancorar onde a reprodução realmente recomeçou
      }
    } else if (t > maxPlayed && t - maxPlayed <= delta + 0.05) {
      maxPlayed = t;
    }

    if (stableDuration && t >= stableDuration - 0.35 && watchedToEnd()) {
      nextShort();
    }
  }

  // Rebobinar exige voltar a ver até ao fim (senão, um sinal falso após
  // um rewind podia reaproveitar um maxPlayed antigo). A re-âncora fica
  // PENDENTE e prende-se na retoma (primeiro timeupdate contínuo), não no
  // alvo do seek — o primeiro evento após um seek/wrap é rejeitado pelo
  // filtro de deltas e a cabeça escapa uns passos à frente do alvo; ancorar
  // no alvo deixava maxPlayed órfão e matava os retries do modo stalled.
  // A janela de 3 s limita a re-âncora à vizinhança do alvo: um salto para
  // a frente SEM evento seeked (transitório de reload) não a pode usar.
  // Saltar para a frente ancora já, sem crédito: a reprodução recomeça mais
  // à frente do que o maxPlayed e a continuidade nunca chega a fechar.
  function onSeeked(e) {
    if (!mediaConfirmed) return; // seek da cauda antiga: não é deste Short
    const t = e.target.currentTime;
    if (t < maxPlayed) {
      maxPlayed = t;
      creditAnchored = false;
      reanchorNear = t;
    } else {
      creditAnchored = true;
      reanchorNear = -1;
    }
  }

  function tick() {
    if (disabled) return;

    // Navegou para outro Short (manual ou automático): estado limpo. Isto
    // também confirma que a última tentativa de avanço resultou.
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      resetShortState();
      advanceAt = 0;
      failedAdvances = 0;
      stalled = false;
    }

    // Vigia: tentámos avançar e o URL não mexeu (fila do YouTube sem próximo
    // Short, ou seletores mortos). NUNCA ficar congelado: devolve-se já o
    // loop nativo e retoma-se a reprodução — o Short repete como o YouTube
    // faria — e o fast-path do timeupdate tenta outra vez a cada passagem
    // pelo fim (a fila pode entretanto ter chegado). Só à 5.ª falha seguida
    // é que se desiste de vez.
    if (advanceAt && Date.now() - advanceAt > 2500) {
      advanceAt = 0;
      failedAdvances++;
      stalled = true;
      resumeNativeLoop(currentVideo);
      if (failedAdvances >= 5) { giveUp(); return; }
    }

    // Saímos dos Shorts entre dois ticks: desliga tudo já, sem esperar pelo
    // evento de navegação. Deixar o loop trancado no elemento afetaria o
    // leitor normal se o YouTube o reciclar.
    if (!isShortsPage()) { stopEngine(); return; }

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

    // Em modo stalled o loop fica entregue ao YouTube — é o que mantém o
    // vídeo a repetir enquanto não há para onde avançar. Não re-trancar.
    if (!stalled) {
      lockLoop(video);
      // O YouTube pode contornar a tranca via setAttribute('loop').
      if (video.hasAttribute('loop')) video.removeAttribute('loop');
    }

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

      // Fim sem crédito: confirmar por persistência. Se um "ended" numa
      // posição plausível sobrevive >=1.2s, é um fim real — um transitório
      // de reload teria retomado a reprodução entretanto. Exige-se a âncora
      // (creditAnchored): prova de que a reprodução DESTE Short começou de
      // verdade (arranque perto de 0 ou seek real). Sem ela, um "ended" da
      // cauda do Short anterior avançava em cadeia — era o salto para os
      // próximos vídeos ao redimensionar a janela (ou com rede lenta).
      if (video.ended) {
        const now = Date.now();
        if (!provisionalEndedAt) provisionalEndedAt = now;
        if (creditAnchored && endIsPlausible(video)) {
          if (now - provisionalEndedAt >= 1200 && now >= suppressUntil) {
            nextShort();
          }
        } else if (now - provisionalEndedAt >= 5000) {
          // Rede final anti-congelamento: um ended persistente que NUNCA
          // vai poder avançar (sem âncora, ou em posição implausível) não
          // fica parado — loop nativo de volta; a próxima navegação repõe.
          stalled = true;
          resumeNativeLoop(video);
        }
      } else if (provisionalEndedAt) {
        provisionalEndedAt = 0; // retomou (ou nem estava no fim): transitório
      }
      return;
    }

    if (currentVideo) releaseVideo(currentVideo);

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

  // ---------------------------------------------------------------------
  // Motor: liga só nos Shorts, desliga ao sair.
  // ---------------------------------------------------------------------

  function startEngine() {
    if (engineTimer || disabled) return;
    lastPath = location.pathname;
    // No arranque a frio (a página abriu já num Short) o estado inicial já
    // é o estado limpo, e não há cauda de Short anterior a desconfiar —
    // repor aqui poria o mediaConfirmed a false sem necessidade.
    if (booted) resetShortState(); else booted = true;
    window.addEventListener('resize', suppress);
    document.addEventListener('fullscreenchange', suppress);
    document.addEventListener('webkitfullscreenchange', suppress);
    // O YouTube é uma SPA: o vídeo troca sem recarregar a página, por isso
    // verificamos periodicamente qual é o vídeo ativo.
    engineTimer = setInterval(tick, 500);
    tick();
  }

  function stopEngine() {
    if (engineTimer) { clearInterval(engineTimer); engineTimer = null; }
    window.removeEventListener('resize', suppress);
    document.removeEventListener('fullscreenchange', suppress);
    document.removeEventListener('webkitfullscreenchange', suppress);
    if (currentVideo) { releaseVideo(currentVideo); currentVideo = null; }
    pendingAdvance = false;
    advanceAt = 0;
    failedAdvances = 0;
  }

  function route() {
    if (disabled) return;
    if (isShortsPage()) startEngine();
    else stopEngine();
  }

  document.addEventListener('yt-navigate-finish', route);
  window.addEventListener('popstate', route);
  // Rede de segurança caso o evento do YouTube mude de nome. Fora dos Shorts
  // este é o ÚNICO trabalho do script: uma comparação de string de 2 em 2
  // segundos, sem tocar no DOM. Com o motor a andar nem isso corre.
  routeTimer = setInterval(() => { if (!engineTimer) route(); }, 2000);
  route();
})();

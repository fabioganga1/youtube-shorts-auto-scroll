# YouTube Shorts Auto Scroll

Userscript (Tampermonkey) que faz **scroll automático nos YouTube Shorts**: quando um
Short termina, passa automaticamente para o seguinte — sem tocar em nada.
(Apenas YouTube **desktop**; o site mobile usa outra interface sem os mecanismos
de navegação necessários.)

## Instalação

1. Instala a extensão [Tampermonkey](https://www.tampermonkey.net/) no browser.
2. Clica aqui para instalar o script:

   **[➜ Instalar youtube-shorts-auto-scroll.user.js](https://raw.githubusercontent.com/fabioganga1/youtube-shorts-auto-scroll/main/youtube-shorts-auto-scroll.user.js)**

3. Abre o YouTube Shorts e deixa andar. 🎬

As atualizações chegam automaticamente via Tampermonkey (`@updateURL`).

## Como funciona

- **Tranca o *loop* do vídeo** (o YouTube tenta religá-lo constantemente e,
  com loop ativo, o vídeo dá a volta sem disparar `ended`) — assim o fim do
  vídeo é sempre detetado.
- **Invariante anti-falsos-positivos**: só avança se o vídeo foi mesmo visto
  até perto do fim, medido por reprodução contínua acumulada. Resizes,
  fullscreen e trocas de qualidade geram sinais falsos de "fim", mas nunca
  conseguem falsificar a reprodução contínua.
- Para avançar tenta, por ordem: botão nativo "vídeo seguinte" → método
  interno do componente `ytd-shorts` → clique no botão escondido → scroll.
- Funciona com a navegação SPA do YouTube (não é preciso recarregar a página).

## Ligar / desligar

Para desativar o auto-scroll, desliga o próprio script no painel do
Tampermonkey (interruptor do script) — não há botão dentro da página.

## Licença

MIT

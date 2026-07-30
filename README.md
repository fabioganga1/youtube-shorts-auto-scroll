# YouTube Shorts Auto Scroll

Userscript (Tampermonkey) que faz **scroll automático nos YouTube Shorts**: quando um
Short termina, passa automaticamente para o seguinte — sem tocar em nada.

## Instalação

1. Instala a extensão [Tampermonkey](https://www.tampermonkey.net/) no browser.
2. Clica aqui para instalar o script:

   **[➜ Instalar youtube-shorts-auto-scroll.user.js](https://raw.githubusercontent.com/fabioganga1/youtube-shorts-auto-scroll/main/youtube-shorts-auto-scroll.user.js)**

3. Abre o YouTube Shorts e deixa andar. 🎬

As atualizações chegam automaticamente via Tampermonkey (`@updateURL`).

## Como funciona

- Desativa o *loop* do vídeo e escuta o evento `ended` (com um *fallback* via
  `timeupdate` para o caso de o YouTube reativar o loop).
- Quando o vídeo acaba, clica no botão nativo "vídeo seguinte" do YouTube;
  se o botão não existir, faz scroll no contentor dos reels.
- Funciona com a navegação SPA do YouTube (não é preciso recarregar a página).

## Ligar / desligar

Para desativar o auto-scroll, desliga o próprio script no painel do
Tampermonkey (interruptor do script) — não há botão dentro da página.

## Licença

MIT

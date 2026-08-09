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
- **Invariante anti-falsos-positivos**: só avança *de imediato* se o vídeo foi
  mesmo visto até perto do fim, medido por reprodução contínua — a posição de
  crédito só cresce quando a cabeça de leitura está mesmo em cima dela, por
  isso arrastar a barra para a frente não conta como visto. Resizes, fullscreen
  e trocas de qualidade geram sinais falsos de "fim", mas não conseguem
  falsificar a reprodução contínua.
- **Um fim sem esse crédito também avança**, só que por confirmação: se o
  `ended` acontecer numa posição plausível e sobreviver 1,2 s, é um fim real
  (um transitório de reload teria retomado a reprodução). Sem isto, trancar o
  loop e não avançar deixaria o Short congelado no último frame.
- Para avançar tenta, por ordem: botão nativo "vídeo seguinte" → método
  interno do componente `ytd-shorts` → clique no botão escondido → scroll.
- **Rede de segurança**: se duas tentativas seguidas não mudarem o URL (sinal
  de que o YouTube mexeu no DOM e os seletores ficaram obsoletos), o script
  devolve o loop nativo, desliga-se e avisa na consola — em vez de deixar o
  vídeo parado sem explicação.
- Funciona com a navegação SPA do YouTube (não é preciso recarregar a página).
  Ao sair dos Shorts, larga o elemento `<video>` e destranca o `loop`.

## Só corre nos Shorts

Duas trancas:

1. **`@match https://www.youtube.com/shorts/*`** — num vídeo normal do YouTube
   o script nem chega a ser injetado. Não existe na página, ponto final.
2. **Motor por rota** — uma vez injetado, o script sobrevive à navegação SPA
   da sessão. Se a partir dos Shorts fores parar a um `/watch`, o motor
   (intervalo de 500 ms, listeners de `resize`/`fullscreen`, listeners do
   `<video>`, tranca do `loop`) é desmontado na hora. Fica só uma comparação
   de string de 2 em 2 segundos — que nem sequer corre enquanto estás nos
   Shorts — e nenhum contacto com o leitor.

### O F5 da primeira vez

O Tampermonkey injeta os scripts na carga do documento, e o YouTube entra nos
Shorts por `pushState` (sem recarregar). Consequência: se abrires o YouTube na
homepage e depois clicares em **Shorts**, o script não é injetado — carrega
**F5** uma vez e fica a funcionar durante o resto da sessão. Se abrires um
link de Short diretamente, ou tiveres os Shorts nos favoritos, isto não te
acontece.

É uma troca deliberada: prefere-se um F5 ocasional a ter o script presente em
todas as páginas do YouTube.

## Ligar / desligar

Para desativar o auto-scroll, desliga o próprio script no painel do
Tampermonkey (interruptor do script) — não há botão dentro da página.

## Licença

[MIT](LICENSE)

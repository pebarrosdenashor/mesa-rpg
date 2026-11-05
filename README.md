# Mesa — mesa virtual de RPG

Mesa virtual feita sob medida para jogar com os amigos: mapa com grid, tokens, régua, dados, chat e fichas no modelo Ordem Paranormal. Roda direto no navegador, hospedada de graça no GitHub Pages, com o Supabase (gratuito) sincronizando tudo em tempo real.

## O que já faz

- **Mesas com código**: o mestre cria a mesa e manda o link de convite. O "link de mestre" abre a mesa como mestre em outro aparelho.
- **Mapa**: envie qualquer imagem como mapa, ajuste o tamanho do quadrado, cor e opacidade do grid e quanto vale cada quadrado (1,5 m por padrão).
- **Tokens**: arrastar com encaixe no grid (todos veem o movimento ao vivo), cor, imagem, tamanho 1×1 a 4×4, ligação com ficha (mostra barra de vida), tokens escondidos dos jogadores, trazer para frente / enviar para trás.
- **Régua** (tecla R) visível para todos, **ping** com Shift+clique.
- **Dados**: notação `1d20+5`, `3d20kh1` (mantém o maior), `2d20kl1` (mantém o menor), somas como `2d6+1d4-1`. No chat: `/r 1d20+3 Luta` ou `/gr 1d20` para rolagem secreta (só você e o mestre veem).
- **Fichas Ordem Paranormal**: atributos, PV/PE/SAN com botões +/−, NEX, defesa, todas as perícias com grau de treino, ataques (teste + dano), habilidades, inventário e anotações. Clicar num atributo ou perícia rola o teste do jeito do sistema (nº de d20 = atributo, fica com o maior; atributo 0 rola 2d20 e fica com o menor).
- **Permissões**: cada jogador vê e edita só a própria ficha e move só os próprios tokens; o mestre vê e controla tudo, cria NPCs, troca o dono de fichas e pode deixar uma ficha visível a todos.

## Extensões do Owlbear Rodeo

A Mesa roda extensões feitas para o Owlbear Rodeo **sem precisar mudar nada nelas**: ela fala o mesmo "idioma" do SDK do Owlbear (`@owlbear-rodeo/sdk`). Já vêm ativadas:

- **Fichas de Ordem Paranormal** — `pebarrosdenashor.github.io/fichas-ordem-paranormal`
- **Hexatombe** — `pebarrosdenashor.github.io/hexatombe`
- **Escudo do Mestre — Hexatombe** — `pebarrosdenashor.github.io/mestre-hexatombe`

Os ícones ficam na coluna à esquerda do mapa; cada um abre a extensão numa janela que dá para arrastar. As partes que rodam em segundo plano (barras de PV/PD no token, sons, sussurros, efeitos de crítico, sino) ficam sempre ligadas. Clique com o botão direito num token para ver as opções das extensões (ex.: "Vincular à ficha aberta").

Para adicionar outra extensão do Owlbear: **⚙ Cena → Extensões**, cole o link do `manifest.json` e clique em *Adicionar*. A lista vale para a mesa inteira.

O que a ponte cobre: jogador e grupo, metadados da sala e da cena, mensagens entre jogadores (broadcast), itens da cena e itens locais (formas, textos, rótulos, imagens, anexos que seguem o token), menus de clique direito, janelas modais e popovers, ação da extensão, avisos, viewport e grid. Ferramentas de desenho personalizadas (`OBR.tool`), névoa e upload de cenas do Owlbear ainda não são suportadas.

## Colocar online (uma vez só, ~10 minutos)

### 1. Supabase (o "servidor")
1. Crie uma conta em <https://supabase.com> e clique em **New project** (plano gratuito).
2. No menu lateral, abra **SQL Editor**, cole todo o conteúdo de [`supabase/schema.sql`](supabase/schema.sql) e clique em **Run**.
3. Clique em **Connect** no topo do projeto (ou vá em **Project Settings → API Keys**) e copie a **URL do projeto** e a chave **publishable** (`sb_publishable_...`).
4. Cole os dois valores em [`js/config.js`](js/config.js):
   ```js
   export const SUPABASE_URL = "https://xxxx.supabase.co";
   export const SUPABASE_ANON_KEY = "sb_publishable_...";
   ```
   (A chave *publishable* — ou a antiga *anon* — é feita para ficar no site; nunca use a *secret* nem a *service_role*.)

### 2. GitHub Pages (o site)
1. Suba esta pasta para um repositório no GitHub.
2. No repositório: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, pasta `/ (root)`.
3. Em um ou dois minutos o site fica em `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.

> Sem o passo 1, o app funciona em **modo local**: dá para testar abrindo duas abas no mesmo navegador, mas os amigos não conseguem entrar.

## Como usar

- **Mestre**: digite seu nome → *Criar mesa* → *Convidar* (copia o link) → mande para os jogadores. Use *Mapa* para subir a imagem e *Cena* para ajustar o grid.
- **Jogador**: abre o link, digita o nome, *Entrar*. Na aba *Fichas*, *Nova ficha*; dentro da ficha, *Criar token no mapa*.
- Rodinha do mouse dá zoom; arrastar o fundo move a câmera; duplo clique num token abre a ficha ligada; Delete apaga o token selecionado (mestre).

## Limites a saber

- Não há login: quem tem o código da mesa entra. As restrições (ficha escondida, rolagem secreta, token oculto) são aplicadas pela interface — alguém que mexa no código pelo navegador conseguiria ver. Para uma mesa entre amigos é suficiente; se um dia quiser proteção de verdade, dá para acrescentar login do Supabase.
- O plano gratuito do Supabase pausa projetos parados por uma semana; é só entrar no painel e reativar.

## Estrutura

```
index.html          interface
css/style.css       visual
js/config.js        chaves do Supabase
js/net.js           sincronização (Supabase ou modo local)
js/board.js         mapa, grid, tokens, régua, ping
js/sheets.js        fichas
js/chat.js          chat e rolagens
js/dice.js          rolador de dados
js/app.js           lobby e cola entre as partes
js/obr-host.js      ponte compatível com o SDK do Owlbear Rodeo
js/dock.js          doca, janelas, modais e popovers das extensões
supabase/schema.sql banco de dados
```

Tudo na mesa é uma "entidade" (`scene`, `token`, `sheet`, `msg`) guardada numa única tabela, então acrescentar coisas novas (iniciativa, névoa de guerra, desenhos, outros sistemas de ficha) é criar um novo tipo de entidade.

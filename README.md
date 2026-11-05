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

## Colocar online (uma vez só, ~10 minutos)

### 1. Supabase (o "servidor")
1. Crie uma conta em <https://supabase.com> e clique em **New project** (plano gratuito).
2. No menu lateral, abra **SQL Editor**, cole todo o conteúdo de [`supabase/schema.sql`](supabase/schema.sql) e clique em **Run**.
3. Vá em **Project Settings → API** e copie a **Project URL** e a chave **anon public**.
4. Cole os dois valores em [`js/config.js`](js/config.js):
   ```js
   export const SUPABASE_URL = "https://xxxx.supabase.co";
   export const SUPABASE_ANON_KEY = "eyJ...";
   ```
   (A chave *anon* é feita para ficar no site; não use a *service_role*.)

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
supabase/schema.sql banco de dados
```

Tudo na mesa é uma "entidade" (`scene`, `token`, `sheet`, `msg`) guardada numa única tabela, então acrescentar coisas novas (iniciativa, névoa de guerra, desenhos, outros sistemas de ficha) é criar um novo tipo de entidade.

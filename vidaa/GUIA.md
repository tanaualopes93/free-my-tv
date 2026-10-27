# Guia do Free My TV na sua Hisense

Este guia é para você usar, sem precisar entender de programação. Cada parte tem um desenho e os passos na ordem.

Sua TV: Hisense 58A51HSV, sistema VIDAA.

---

## 1. O que é cada parte

```
  SUA TV                                         SEU COMPUTADOR
 ┌─────────────────────────────┐                ┌──────────────────────────┐
 │  Free My TV (tela inicial)  │                │  Instalador              │
 │   ├─ Prateleira de apps     │   só quando    │   (liga, instala, guarda │
 │   ├─ Loja (botão redondo)   │ <------------- │    cópia da lista da TV) │
 │   └─ Configurações          │   você instala │                          │
 └─────────────────────────────┘   ou restaura  └──────────────────────────┘
```

- **Tela inicial**: a vitrine. Mostra a prateleira só com os apps que abrem de verdade. Os que não abrem ficam apagados, com o aviso "Use o botão do app no controle".
- **Loja**: uma camada da mesma tela. Tem abas: Destaques, IPTV (sua lista), Vídeo e música e Instalados.
- **Instalador do computador**: usado poucas vezes. É ele que põe o Free My TV na TV, guarda cópia da lista de apps e restaura tudo se algo der errado.

Regra de ouro: antes de mexer em qualquer coisa, o instalador guarda uma cópia da lista de apps da TV. Por isso dá para voltar.

---

## 2. Instalar um app pela Loja

Tudo com o controle da TV.

```
 Início ──OK──> Loja ──OK──> Detalhe do app ──OK──> Instalar
```

1. Na tela inicial, escolha o botão **Loja** (redondo, no alto) e aperte OK.
2. Use as setas para escolher a aba e o app. Aperte OK.
3. Na tela do app, aperte OK em **Instalar**.
4. Se a TV pedir confirmação, leia o nome do app e o site de onde ele vem. Se for isso mesmo, escolha **Confirmar**. Se tiver dúvida, **Cancelar**.
5. O botão muda sozinho: Instalando, Conferindo, Avisando a TV. Quando aparecer **Instalado. Já dá para abrir.**, deu certo.
6. Para o app aparecer no menu da TV, tire a TV da tomada por 10 segundos e ligue de novo. Enquanto isso você vê o aviso "Aparece no menu da TV depois de tirar da tomada". Depois de fazer isso, aperte **Já tirei da tomada**.

Depois de instalado, os botões são **Abrir**, **Pôr na prateleira** e **Remover**.

Para remover: aperte OK em Remover. O botão vira **Confirmar remoção** por 4 segundos. Aperte OK de novo para confirmar.

Se aparecer "Não consegui instalar o app. Nada mudou na sua TV.", aperte **Tentar de novo**. Nada foi alterado.

Voltar: o botão Voltar do controle sai da folha, depois da Loja, depois do Início. No Início, o primeiro Voltar mostra "Aperte Voltar de novo para sair". Aperte de novo em até 2,5 segundos.

Sobre os links: em **Adicionar por link** você digita o endereço de um site. A TV mostra o endereço em destaque: confira o nome do site antes de continuar. Quando a conexão for sem proteção, o aviso aparece: use só em redes e endereços em que você confia.

IPTV: os tocadores da aba IPTV usam a lista ou a assinatura que você já tem. A Loja não indica canais.

---

## 3. Usar o instalador do computador

Você usa quando for pôr o Free My TV na TV pela primeira vez, ou instalar quando a Loja pedir o computador.

```
   [PC]  liga o servidor ──> mostra o IP do PC (ex.: 3 grupos de números)
     │
   [TV]  troca o DNS para o IP do PC
     │
   [TV]  abre https://vidaahub.com ──> aceita o aviso ──> Instalar na TV
     │
   [TV]  espera 30 s ──> DNS de volta para automático ──> tira da tomada 10 s
```

Passo a passo:

1. **No computador**, abra o terminal na pasta do projeto e rode:
   `python vidaa/server/servidor.py`
   O servidor mostra o endereço (IP) do seu computador. Anote. Deixe a janela aberta.
2. **Na TV**, abra Configurações, Rede, e troque o DNS de automático para manual. Digite o endereço anotado.
3. **Na TV**, abra o navegador e entre em `https://vidaahub.com`.
4. Vai aparecer um aviso de segurança. Aceite o aviso (é o seu próprio computador falando com a TV).
5. Aperte **Instalar na TV**.
6. Espere 30 segundos. O instalador confere se deu certo.
7. **Volte o DNS da TV para automático.** Senão a TV fica sem internet se o computador for desligado.
8. Tire a TV da tomada por 10 segundos e ligue.

Isso vale para qualquer final: deu certo, deu erro ou você desistiu. **Sempre volte o DNS para automático.**

O painel "Esta TV" mostra o modelo, o sistema e quantos apps estão na lista. Se aparecer algo diferente do esperado, pare e não instale.

---

## 4. Chave do TMDB (fotos e destaques)

Os destaques da tela inicial (as capas grandes) usam o TMDB, um site gratuito de filmes e séries. Ele pede uma chave, como uma senha só sua.

```
  Criar conta ──> Pedir a chave ──> Digitar no instalador ──> Pronto, uma vez só
```

1. Crie uma conta grátis: https://www.themoviedb.org/signup
2. Peça a chave da API: https://www.themoviedb.org/settings/api (escolha o uso pessoal).
3. No instalador do computador, no campo **Chave do TMDB (digite uma vez)**, cole a chave.
4. O instalador grava a chave só dentro da TV. Ela não vai para a internet nem para o GitHub.

Sem a chave, a tela inicial funciona assim mesmo: mostra o relógio grande e as abas Explorar, Filmes e Séries ficam sem conteúdo.

Guarde a chave em lugar seguro. Não mande para ninguém.

---

## 5. Restaurar e emergência

Restaurar devolve a lista de apps da TV para uma cópia guardada. Use se algo sumiu ou se a TV ficou estranha.

```
  Algo deu errado
        │
        ├─ ainda abre o navegador da TV? ──> sim ──> Abra o instalador ──> Restaurar
        │
        └─ o TV Browser sumiu? ──> reinstale pela loja VIDAA ──> abra o instalador ──> Restaurar
```

Passo a passo:

1. Se o **TV Browser** sumiu, reinstale pela loja do próprio VIDAA (a loja que já vem na TV).
2. No computador, ligue o servidor: `python vidaa/server/servidor.py`.
3. Na TV, troque o DNS para o endereço mostrado (veja a parte 3).
4. Abra `https://vidaahub.com`, aceite o aviso e aperte **Restaurar**.
5. O instalador mostra as cópias guardadas. Escolha uma e veja a diferença (o que volta e o que sai).
6. Confirme. Espere. Volte o DNS para automático e tire a TV da tomada por 10 segundos.

Há duas cópias especiais: a **original** (como a TV veio, com 4 apps) e a **último bom** (com o Free My TV funcionando). As cópias ficam no computador em `D:\Backups\free-my-tv-vidaa`. Não apague essa pasta.

---

## 6. Abrir o Free My TV ao ligar a TV

O que se sabe até agora:

- A TV Hisense não tem uma configuração para abrir um app específico ao ligar.
- Uma possibilidade é a TV voltar para o último app que estava aberto quando foi desligada. Isso ainda precisa ser testado na sua TV: ligar logo depois de desligar, depois de meia hora, e depois de tirar da tomada.
- Se o teste funcionar, vai aparecer uma linha em Configurações: **Abrir o Free My TV ao ligar**. Com a explicação: "A TV volta para o último app que estava aberto quando foi desligada. Deixe o Free My TV aberto antes de desligar."
- Se não funcionar, a explicação honesta aparece e nada de novo é prometido.

O botão Início do controle sempre volta para o menu do VIDAA. A TV não entrega essa tecla para os apps.

### Etapa 2: aparelho Google TV (a solução completa)

Um aparelho Google TV, ligado na entrada HDMI, vira a "TV nova": o Free My TV passa a ser a tela inicial de verdade, com todos os apps, e abre ao ligar (pelo HDMI-CEC).

```
   [Aparelho Google TV] ──HDMI──> [Sua Hisense]
        Free My TV Android          só mostra a imagem
```

Preços vistos em anúncios em 26/10/2026 (mudam, confira antes de comprar):

| Aparelho | Preço aproximado | Fonte |
|---|---|---|
| Xiaomi TV Stick 4K | R$ 503 a R$ 617 | [Zoom](https://www.zoom.com.br/busca/google+tv+streamer) e [Buscapé](https://www.buscape.com.br/busca/xiaomi+mi+tv+stick) |
| Xiaomi TV Box S | R$ 789 a R$ 799 | [Buscapé](https://www.buscape.com.br/busca/tv+box+xiaomi) |
| Google TV Streamer (importado) | R$ 700 a R$ 1.250 | [TechTudo](https://www.techtudo.com.br/guia/2025/03/google-tv-streamer-4k-veja-preco-e-tudo-sobre-o-sucessor-do-chromecast-edinfoeletro.ghtml) e [Smart TV Brasil](https://smarttvbrasil.com/tv-box-melhor) |

Trocar o sistema da TV por Android não é recomendado: o sistema é travado pela Hisense e gravar outro pode deixar a TV sem funcionar.

---

## 7. Resumo de uma linha por situação

| Situação | O que fazer |
|---|---|
| Quero instalar um app | Loja, escolher, Instalar |
| O app novo não aparece no menu | Tirar a TV da tomada por 10 segundos |
| A TV ficou sem internet | Voltar o DNS da TV para automático |
| Algo sumiu ou ficou estranho | Instalador, Restaurar |
| O TV Browser sumiu | Reinstalar pela loja VIDAA e depois Restaurar |
| Quero os destaques com capas | Colocar a chave do TMDB (parte 4) |

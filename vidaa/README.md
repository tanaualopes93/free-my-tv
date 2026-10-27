# Free My TV no VIDAA (Hisense)

Parte técnica, curta. Para o passo a passo de uso, leia o [GUIA.md](GUIA.md).

Alvo testado: Hisense 58A51HSV, VIDAA U09.09, navegador Chrome 111, ARMv7 (32 bits).

## Estrutura

```
vidaa/
  build.py         monta out/vidaa/ (tela inicial + Loja + LICENSE); versão = sha + hora
  store/           Loja (só o VIDAA carrega)
    registry.js      ES5, lê e grava a lista de apps da TV (FMTVRegistry)
    store.js/.css    a camada da Loja (FMTVStore), Chrome 111
    strings.json     textos só do VIDAA (pt e en)
    catalogo.json    apps da Loja (+ catalogo.schema.json e icons/)
  shell/           instalador servido em https://vidaahub.com pelo PC
  server/          servidor.py (DNS seletivo + HTTPS) e certificado.py
  tests/           hisense-stub.js, testes node:test e testes do servidor
  check.sh         checagens estáticas (também roda como hook pre-push)
  publicar.sh      check, build --generic, gh-pages, conferência (--voltar desfaz)
local/             fora do git: logs/, servidor.json, certs/
```

O resto do projeto (`web/`) é a tela inicial em ES5, igual para todas as TVs. A Loja é carregada só quando a tela detecta o VIDAA.

## Comandos

| Para quê | Comando |
|---|---|
| Montar o pacote | `python vidaa/build.py --generic` |
| Checar a tela inicial | `tools/check.sh web` (no Windows, com um `python3` apontando para `python`) |
| Checar o VIDAA | `bash vidaa/check.sh` |
| Testes do registry | `node --test "vidaa/tests/*.test.js"` |
| Testes do servidor | `python -m unittest discover -s vidaa/tests -p "test_*.py"` |
| Publicar | `bash vidaa/publicar.sh` |
| Voltar a publicação anterior | `bash vidaa/publicar.sh --voltar` |

A publicação é sempre `--generic`: o pacote não leva chave, cidade nem coordenadas. O `publicar.sh` falha se achar `tmdbKey`, `latitude`, `longitude`, `city`, "PRIVATE KEY" ou o IP da rede de casa em algum arquivo, e confere o `config.js` publicado depois do push. O GitHub Pages guarda cache por cerca de 10 minutos.

## Servidor (no PC)

```
python vidaa/server/servidor.py
```

- Dependência: `pip install dnslib`. O certificado vem do `certificado.py` (ECDSA P-256, SAN `vidaahub.com`, `CA:FALSE`, feito com o `openssl` do Git Bash). Ele nunca é importado no Windows.
- Config em `local/servidor.json`, criada na primeira execução (IP do PC, sub-rede, DNS de saída, portas, pasta de cópias). Portas padrão: DNS 53 (UDP e TCP), HTTPS 443, HTTP 8080. Se o Windows já ocupa a porta 53 (Compartilhamento de Conexão, ICS), ponha `"bind": "<IP do PC>"` na config: o servidor escuta só nesse endereço.
- DNS só para a sub-rede da casa. `vidaahub.com` e `www.vidaahub.com` respondem com o IP do PC; outros tipos de registro voltam vazios (NOERROR); todo o resto é encaminhado. Só a contagem de consultas é registrada.
- HTTPS: `/` e `/shell/*` (instalador), `/store/*` (cópia local, nunca código remoto), `/ping`, `POST /backup`, `GET /backups`, `POST /log`. Corpo JSON de até 256 KB.
- Mantém o PC acordado enquanto roda. Libere o firewall só para a rede privada.

## Segurança: o que nunca vai ao git

- Chave do TMDB. Ela fica só no `localStorage` da TV (entra pelo `#k=` do endereço) e nas cópias de `D:\Backups`.
- `*.key`, `*.pem`, `*.crt`, `*.p12` e a pasta `local/` (cobertos pelo `.gitignore`).
- O IP da rede de casa. Os exemplos usam arquivos `*.example.*`.
- Cópias da lista da TV (`D:\Backups\free-my-tv-vidaa`).
- Código sem licença de terceiros (o `vidaa-appstore` antigo não é copiado para cá).

Regras de gravação do `registry.js`: só mexe nas entradas nossas (`fmtv_*` e `FreeMyTV`); só grava depois de a cópia ser confirmada; relê e confere depois de gravar; domínios aceitos ficam numa lista fixa dentro do próprio arquivo; o catálogo não acrescenta domínio. A restauração total da lista é só pelo instalador do PC.

## Exceção ao CLAUDE.md do upstream

Trocar o DNS da TV para o PC contraria o "não mudar a rede da TV" do `CLAUDE.md` original. A exceção foi aprovada neste projeto (ADR-004) e toda tela do instalador termina pedindo para voltar o DNS para automático.

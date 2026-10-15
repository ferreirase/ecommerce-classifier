# Jev Classifier POC

Prova de conceito: classificar os produtos de um agregador de cupons só com o Jev (TypeSafe System One, chamado pelo OpenRouter) e comparar com a classificação atual (`category_name`, gerada por embeddings + rerank). O classificador atual erra muito na loja Posthaus, principalmente entre roupa infantil e roupa adulta.

Relatório completo, com todos os resultados e julgamentos: [`reports/relatorio-jev.html`](reports/relatorio-jev.html).

## Resultado em resumo

| Conjunto | Configuração | Acurácia estimada | Erros claros do Jev | Custo / 1.000 produtos |
|---|---|---|---|---|
| Baseline (100, várias lojas) | Texto | 85–96% | 4 | US$ 0,22 |
| Posthaus (172) | Texto | 92–98% | 4 | US$ 0,22 |
| Posthaus (172) | Texto + pergunta de idade | 93–99% | 1 | US$ 0,23 |
| Posthaus (172) | **Imagem primeiro, texto como fallback** | **98–100%** | **0** | **US$ 0,16** |
| Validação (150 roupas e calçados de outras lojas) | Imagem primeiro | 95–99% | 1 | US$ 0,23 |

- **Acurácia estimada:** o valor baixo conta os casos ambíguos como erro, e o valor alto conta como acerto.
- **Julgamento:** o Claude julgou as divergências pela descrição oficial das categorias e, na Parte 5, pelas fotos. Uma pessoa não revisou esse julgamento.
- **Concordâncias não revisadas:** um produto em que os dois sistemas erram igual conta como acerto. Duas dessas concordâncias erradas foram encontradas no caminho.

**Recomendação:**
- **Lojas de moda como a Posthaus:** use a cascata com imagem. A foto mostra se o produto é para criança ou para adulto quando o texto não diz.
- **Lojas que escrevem "infantil" no título:** use texto com pergunta de idade. O resultado é o mesmo, e cada produto leva cerca de 0,3 s em vez de 1 s.
- **Concorrência:** use um teto entre 32 e 64 requests em paralelo.

## Rodar

```bash
npm install
cp .env.example .env.local   # preencha OPENROUTER_API_KEY
npm run import               # lê o xlsx e gera os conjuntos em data/ (python3, só biblioteca padrão)
npm run dev
```

Abra `http://localhost:3000`. Cada aba lista os produtos de um conjunto sem classificação. Escolha a configuração e clique em "Classificar com Jev". Os resultados chegam em tempo real.

`npm test` roda os testes (pool, regra de idade, leitura de imagem).

## Conjuntos (`npm run import`)

| Arquivo | Conteúdo |
|---|---|
| `data/baseline.json` | 100 produtos não-Posthaus, amostra estratificada (1 a 2 por categoria, 51 categorias) |
| `data/posthaus.json` | os 172 produtos Posthaus |
| `data/validacao.json` | 150 roupas e calçados de outras lojas: 75 infantis e 75 adultos pela categoria atual |
| `data/carga.json` | 600 produtos aleatórios, só para testes de carga |

As amostras usam seed fixa. Gerar de novo não muda os arquivos. Os arquivos `data/*-run-*.json` guardam os resultados das execuções usadas no relatório.

## Configurações (seletor no app)

| Valor | O que faz |
|---|---|
| `off` | 1 pergunta Choice sobre as 51 categorias habilitadas de `categorias.txt` |
| `generic` | `off` + 1 pergunta Noul "o produto é feito para crianças?". Se a resposta é ≥ 0,5 e a categoria é adulta, o código troca para a versão infantil. Só nesse sentido |
| `brands` | `generic` + uma lista de marcas infantis. Quatro dessas marcas vieram dos dados da Posthaus, então o resultado na Posthaus é otimista |
| `image` | Cascata. Etapa 1: foto + texto escolhem o grupo de categorias. Etapa 2: se a confiança do grupo é ≥ 0,8, uma Choice de texto escolhe entre as categorias do grupo; se o grupo tem 1 categoria, não há etapa 2. Fallback: `generic`, quando o grupo é incerto ou a foto não serve |

O campo `category_name` nunca vai para o Jev, porque é o rótulo comparado.

## Código

| Arquivo | Responsabilidade |
|---|---|
| `lib/jev.ts` | Pergunta de categoria pelo SDK `@typesafe-ai/sdk`. Chamada HTTP direta para requests com imagem. Classificação dos erros em transitório ou fatal |
| `lib/audience.ts` | Pergunta de idade e regra de troca adulto → infantil |
| `lib/cascade.ts` | Cascata "imagem primeiro, texto como fallback" |
| `lib/images.ts` | Download da foto, leitura de formato e tamanho pelo cabeçalho, limites do Jev |
| `lib/pool.ts` | Pool de workers com limite adaptativo |
| `lib/jobs.ts` | Um job por conjunto, estado em memória, eventos para o SSE |
| `app/api/classify/[set]` | `POST` inicia (`{variant, concurrency?}`), `DELETE` cancela, `GET` devolve o estado. `/stream` envia os eventos por SSE |
| `scripts/import.py` | Lê o xlsx de 160 MB em streaming e gera os conjuntos |

### Concorrência (`lib/pool.ts`)

- **Cursor compartilhado:** os workers pegam itens de um cursor comum, então um item lento não bloqueia os outros.
- **Limite adaptativo:** um semáforo controla quantas chamadas rodam ao mesmo tempo. O limite vai de 1 até `JEV_CONCURRENCY`.
  - Erro transitório (`429`, 5xx, rede): o limite cai pela metade, no máximo uma vez por segundo.
  - Latência: se o p95 das últimas 20 chamadas passar de 3× o melhor p50 da execução, o limite cai 25%, até 1/8 do teto.
  - A cada 10 sucessos sem esses sinais, o limite sobe 1.
- **Novas tentativas:** cada item tenta até 5 vezes, com backoff exponencial e jitter. A espera do backoff não ocupa vaga. Só um `Retry-After` do servidor pausa todos os workers. O OpenRouter não envia esse header.
- **Falhas:** o erro de um item não para o job. `401`/`402` param o job inteiro. Cancelar aborta os requests em andamento.
- **Job e app:** o job conta as novas tentativas por causa, os cortes de limite (erro ou latência) e o menor limite atingido. A barra de progresso do app mostra esses números.

## Variáveis de ambiente (`.env.local`)

| Variável | Padrão | Uso |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Obrigatória. Nunca vai para o navegador |
| `JEV_MODEL` | `jev-latest` | Modelo do Jev. As execuções do relatório usaram `jev-1.14` |
| `JEV_CONCURRENCY` | `8` no código, `64` no `.env.example` | Teto de requests em paralelo |
| `JEV_BASE_URL` | `https://openrouter.ai/api` | Endpoint System One |

## O que aprendemos sobre Jev pelo OpenRouter

- **Formato de imagem:** o SDK oficial manda imagens em multipart, e o OpenRouter recusa. O formato `assets` responde `200`, mas ignora a imagem. O formato que funciona é uma parte `image_url` com data URL dentro do `state`, com o header `TypeSafe-Danger-Zone-Images: true`.
- **Limites da imagem:** PNG ou JPEG, de 256 a 1568 px por lado. O Jev recusou uma foto dentro desses limites ("Invalid image dimensions"). O app manda esses casos para o fallback de texto.
- **Custo da imagem:** uma foto de 600×830 custa cerca de 1.340 tokens. Requests com imagem rodam no modo de contexto longo, de 2 a 4 vezes mais lento.
- **Limite de taxa:** o `429` apareceu já com 32 requests em paralelo, sem `Retry-After`. A melhor vazão medida foi cerca de 50 produtos/s com 64 em paralelo. Acima de 64, o provedor enfileira os requests e os downloads de fotos das lojas falham. A vazão variou mais de 2× entre execuções com a mesma configuração.
- **Determinismo:** com confiança perto de um empate (≤ 0,61), a mesma pergunta pode mudar de resposta entre execuções.

## Limitações

- As amostras são pequenas (100, 172 e 150 produtos), e uma pessoa não revisou o julgamento.
- A regra de idade e o limite de 0,8 da cascata foram escolhidos com os dados da Posthaus. A validação em outras lojas mostrou que a regra não cria erros, mas não mediu o ganho: 73 dos 75 infantis dessas lojas têm "Infantil" no texto.
- Imagens são experimentais no Jev. O formato, os limites e a precisão podem mudar entre versões.
- O estado dos jobs fica em memória. Reiniciar o servidor perde os resultados que não foram salvos em `data/`.

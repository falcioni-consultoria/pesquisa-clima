# Falclima — Falcioni Consultoria

App para aplicar pesquisas de clima organizacional durante a entrevista com o cliente: o consultor faz a pergunta, marca a nota/nível com um toque e digita o comentário do respondente (o app corrige sozinho os erros de digitação rápida). O relatório (média por pergunta, comentários anônimos) vai sendo montado em tempo real conforme cada pessoa responde.

Dois modelos prontos, no mesmo ambiente:
- **Nota 0 a 10** — 10 perguntas padrão (extraídas do modelo real já usado) + 2 abertas.
- **Concordância / Satisfação** — as mesmas 10 dimensões, em escala de 5 níveis (concordância, satisfação ou frequência conforme a pergunta) + 2 abertas.

Em "Nova pesquisa" dá para editar, remover, reordenar ou adicionar perguntas livremente antes de começar a coletar — os modelos são só um ponto de partida.

## 1. Firebase

Usa o **mesmo projeto Firebase do Falcioni KPIs** (`falcioni-kpis`, console: https://console.firebase.google.com/project/falcioni-kpis), já configurado em [firebase-config.js](firebase-config.js). As coleções deste app (`sessions` e `sessions/{id}/respondentes`) são próprias, não colidem com as do KPIs.

Testado (leitura e escrita reais, depois apagado): as regras do Firestore desse projeto já permitem o acesso que o app precisa, então não é necessário nenhum passo extra aqui.

Se um dia as regras desse projeto forem revisadas/restringidas, garanta que este bloco continue liberado:

```
match /sessions/{sessionId} {
  allow read, write: if true;
  match /respondentes/{respondenteId} {
    allow read, write: if true;
  }
}
```

> Fica aberto (sem login) para simplificar o uso em campo — qualquer pessoa com o link do app consegue ler/escrever nessas duas coleções. Se quiser reforçar depois, dá pra adicionar autenticação por senha; me avise quando quiser isso.

## 2. Publicar (GitHub Pages)

Tudo fica no GitHub, sem token de terceiro para renovar. Repositório: https://github.com/falcioni-consultoria/pesquisa-clima

O GitHub Pages já está ativado (branch `main`, pasta `/`). O app fica no ar em:

**https://falcioni-consultoria.github.io/pesquisa-clima/**

Toda atualização é só `git push` — o GitHub publica sozinho em 1-2 minutos, sem nenhum passo manual.

## 3. Usar

1. **Nova pesquisa** → nome do cliente, segmentos (setores) opcionais, escolher modelo (ou editar as perguntas) → "Criar pesquisa e começar a coletar".
2. Na coleta: escolha o segmento do respondente (se configurado), toque na nota/nível e digite o comentário — erros de digitação são corrigidos ao apertar espaço (toque na etiqueta amarela para desfazer). Use "← Anterior" para acrescentar algo. Ao terminar as perguntas, o app já abre um novo respondente automaticamente.
3. **Relatório** (acessível a qualquer momento pela lista de pesquisas) mostra a média e a distribuição de cada pergunta, comentários anônimos (só "Respondente N", nunca o nome) e um botão para imprimir/salvar em PDF.
4. A autocorreção usa um dicionário de português próprio (`dicionario-pt.txt`, ver `dicionario-pt-LICENCA.txt`) e pode ser desligada no botão "✍️ Autocorreção da digitação".

## Estrutura

- `index.html`, `style.css`, `app.js` — a aplicação.
- `questions.js` — banco de perguntas padrão dos dois modelos.
- `autocorrecao.js` + `dicionario-pt.txt` — autocorreção da digitação rápida em português.
- `firebase-config.js` — credenciais do projeto Firebase `falcioni-kpis` (compartilhado com o Falcioni KPIs).
- `manifest.json`, `sw.js`, `icons/` — PWA (instalável no celular/tablet).

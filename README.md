# Interval Timer

Timer intervalado (atividade / descanso / ciclos) com predefinições. HTML, CSS e JavaScript puros, sem dependências e sem build.

## Rodar

Os módulos ES exigem um servidor HTTP (abrir o `index.html` direto pelo `file://` não funciona):

```sh
npm start          # python3 serve.py 8080 → http://localhost:8080
```

Qualquer servidor estático serve (também dá para hospedar no GitHub Pages, Netlify etc.).

## Testes

```sh
npm test           # node --test (Node 18+)
```

Testes de navegador (layout, sons, Wake Lock, campos): com `npm start` rodando, abra http://localhost:8080/tests/browser/regression.html — usa relógio, áudio e Wake Lock simulados; o `localStorage` dessa origem é sobrescrito durante o teste e restaurado ao final.

## Estrutura

| Arquivo | Responsabilidade |
|---|---|
| `src/timer.js` | Motor do timer (puro, sem DOM): sequência de fases, estado a partir do tempo decorrido, pausa/retomada por timestamps. |
| `src/storage.js` | Repositório de persistência (configuração + predefinições) sobre `localStorage`. Para migrar para um backend, implemente os mesmos métodos (`loadSettings`, `saveSettings`, `listPresets`, `savePreset`, `deletePreset`). |
| `src/sound.js` | Bipes curtos via Web Audio. |
| `src/app.js` | Interface: liga o DOM ao motor e ao repositório. |

O tempo é sempre calculado com `performance.now()` (relógio monotônico), nunca contando ticks; o `setInterval` serve apenas para redesenhar a tela. Por isso o tempo continua correto com a aba em segundo plano.

Sequência de cada ciclo: atividade → alarme de fim (4,5 s, fundo piscando em vermelho; o descanso só começa depois) → descanso (com bipes nos últimos 5 s). Após a última atividade toca o alarme e o treino termina, sem descanso.

Atalho: <kbd>Espaço</kbd> inicia / pausa.

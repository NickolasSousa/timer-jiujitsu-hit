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

Testes de navegador (layout, sons, Wake Lock, campos): com `npm start` rodando, abra **http://127.0.0.1:8080/tests/browser/regression.html**. Usam relógio, áudio e Wake Lock simulados.

A página só roda em `127.0.0.1:8080`. Use o app por `http://localhost:8080`: o `localStorage` é separado por origem, então os testes nunca tocam nas suas predefinições. Aberta em `localhost`, a página não executa e explica o motivo.

## Estrutura

| Arquivo | Responsabilidade |
|---|---|
| `src/timer.js` | Motor do timer (puro, sem DOM): sequência de fases, estado a partir do tempo decorrido, pausa/retomada por timestamps. |
| `src/storage.js` | Repositório de persistência (configuração + predefinições) sobre `localStorage`. Para migrar para um backend, implemente os mesmos métodos (`loadSettings`, `saveSettings`, `listPresets`, `savePreset`, `deletePreset`). |
| `src/sound.js` | Sons via Web Audio, sem arquivos de áudio. Ao iniciar ou continuar, agenda todos os sons restantes do treino (bipe de início, alarme, contagem, conclusão) no relógio do `AudioContext`; pausar, reiniciar ou encerrar cancela o agendamento. |
| `src/app.js` | Interface: liga o DOM ao motor e ao repositório. |

O tempo é sempre calculado com `performance.now()` (relógio monotônico), nunca contando ticks; o `setInterval` serve apenas para redesenhar a tela. Por isso o tempo exibido continua correto com a aba em segundo plano, e os sons, agendados no relógio de áudio, não dependem da tela ser redesenhada.

Sequência de cada ciclo: atividade → alarme de fim (4,5 s, fundo piscando em vermelho; o descanso só começa depois) → descanso (com bipes nos últimos 5 s). Após a última atividade toca o alarme e o treino termina, sem descanso.

Configuração: segundos acima de 59 são convertidos em minutos ao sair do campo (75 s → 1 min 15 s). Atividade com duração 0:00 é marcada como inválida, não é aplicada nem salva, e o botão Iniciar fica desabilitado até ser corrigida.

Atalho: <kbd>Espaço</kbd> inicia / pausa.

## Limitações

- **Áudio:** navegadores e sistemas podem suspender o áudio em segundo plano, especialmente no iOS (tela bloqueada, troca de app) e com economia de bateria. Enquanto suspenso, nenhum som toca; ao voltar à aba o app tenta retomar e, se o navegador exigir, mostra "Toque na tela para tentar reativar". Os sons do período suspenso não são tocados depois.
- **Tela ligada (Wake Lock):** só funciona em contexto seguro, ou seja HTTPS ou `localhost`. Acessando pelo IP da rede local em http (ex.: celular em `http://192.168.x.x:8080`), a tela pode apagar durante o treino. O navegador libera o bloqueio ao esconder a aba; o app pede de novo ao voltar.

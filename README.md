# claude-mods

Моды для [Claude Code](https://claude.com/claude-code). Пока здесь один: **reactions**.

## reactions — реакции на сообщения, как в мессенджере

Ставишь реакцию на любое сообщение Claude, включая промежуточные между вызовами инструментов, и не прерываешь его работу. Claude получает реакцию вместе с результатом своего следующего инструмента. Если он в этот момент не работает — вместе с твоим следующим сообщением. Получив реакцию, Claude её учитывает:

| Реакция | Что Claude делает |
|---|---|
| 👍 | продолжает так же |
| 👎 | останавливается, в двух словах говорит, что делает, и спрашивает, как нужно |
| 🤔 | перепроверяет этот шаг |
| 😂 ❤️ 🔥 | ничего, это просто эмоция |

Claude тоже реагирует:

- ставит метки на твоих сообщениях: 👀 — прочитал, ✅ — ход закончен, ⏹️ — остановлен, ⚠️ — ошибка. Сообщение, отправленное посреди работы, получает 👀 в момент, когда Claude его подхватил;
- может поставить свою реакцию (😂, ❤️, 🤝, 🙏…) через инструмент `react`.

### Как выглядит

В правом нижнем углу каждого сообщения Claude — бледный ☺. Наведи курсор на сообщение — рядом раскроется ряд реакций. Можно и просто нажать ☺. Выбранная реакция встаёт под сообщением с короткой вспышкой пиксельных искр, повторное нажатие на неё её убирает. Само сообщение рисует приложение, мод только добавляет реакции.

### Установка

Нужен Claude Code 2.1.287 или новее. Команды выполняются в терминале:

```bash
claude plugin marketplace add ohjohnnyoh/claude-mods
claude plugin install reactions@johnny-mods
```

После этого открой новый чат или выполни `/reload-plugins` в терминальном Claude Code.

**Где работает:** вкладка Code в десктопном приложении Claude и терминал. В терминале курсор и клики работают в полноэкранном режиме.
**Где не работает:** обычный чат claude.ai, мобильное приложение и VS Code — там моды не отображаются.

### Приватность

Мод ничего не отправляет наружу. Реакцию видит только Claude в твоём же чате: она приходит ему скрытой заметкой. Реакции и метки хранятся локально, в хранилище плагинов Claude Code, для последних 30 чатов, поэтому переживают перезапуск приложения.

### Собрать самому

[`AGENT_PROMPT.md`](AGENT_PROMPT.md) — промпт, по которому Claude Code соберёт такой же мод с нуля. Там же собраны неочевидные места API модов, на которые мы наткнулись.

### Разработка

```bash
claude plugin validate reactions
claude plugin test reactions
```

---

### English

**reactions** brings messenger-style reactions to Claude Code (the Code tab of the Claude desktop app, and the terminal). React to any of Claude's messages, interim ones between tool calls included, without interrupting it: the reaction reaches Claude with its next tool result (or with your next message when it is idle). 👍 keep going, 👎 stop and ask, 🤔 double-check this step; anything else is just a feeling. Claude marks your messages 👀 (read) → ✅ (done), ⏹️ (stopped), ⚠️ (error), and can react with an emoji of its own. Nothing leaves your machine; reactions are kept in Claude Code's local plugin store. Install from a terminal with the two commands above. The texts Claude reads are in Russian.

## Лицензия

MIT, см. [LICENSE](LICENSE).

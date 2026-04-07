# Документация интеграции NULLXES AI

Техническое описание содержимого каталога `docs/` для команд интеграции (C++ Zoom-клиент, JobAI Backend) и внутренней разработки.

## Назначение

Документы в этом каталоге фиксируют **контракты** между внешними системами и сервисом `NULLXES_AI_AGENT_ZOOM`. Текст согласован с **фактическим кодом** в `src/` там, где это возможно; всё, чего в репозитории ещё нет, помечено как **v1.1** / **TO BE IMPLEMENTED** / open questions — чтобы не путать «уже работает» с «договорились сделать».

## Состав


| Файл                                             | Что описывает                                                                                                                                                                                                   | Аудитория                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **[control_protocol.md](./control_protocol.md)** | HTTP control plane: эндпоинты, тела запросов/ответов, ошибки, реестр сессий, сигналы процесса; целевой WebSocket `/ws/control`; целевые webhooks в JobAI; ASCII-сценарии; открытые вопросы.                     | Оркестратор (JobAI), интеграторы API |
| **[audio_protocol.md](./audio_protocol.md)**     | WebSocket-аудиоплоскость: что реализовано сейчас (`AudioCaptureBridge`, PCM, порт, query `session`); целевой full-duplex `/ws/audio`; паузы, barge-in, heartbeat/reconnect — где в коде есть и где только план. | C++ клиент, аудио/нижний уровень     |


## Связь с кодом (кратко)

- **Control HTTP** — `src/backend/control_server.js`, приложение поднимается в `src/backend/index.js` (`CONTROL_PORT`, по умолчанию 8080).
- **Реестр и лимит параллельных сессий** — `src/backend/session_registry.js` (`MAX_CONCURRENT_SESSIONS`).
- **Жизненный цикл агента и FSM** — `src/agent/session_worker.js`, состояния — `src/agent/interview/state_machine.js`.
- **Аудио с браузера в Node** — `src/agent/audio_capture_bridge.js`, `src/agent/audio_bridge_singleton.js`, инжект из страницы — `src/bot/audio_capture.js`.
- **TTS в динамик/мик** — `src/agent/audio_pacer.js`, режимы `AUDIO_OUT_MODE` (`browser_injection` / `virtual_mic`), Pulse — `src/agent/audio_sink_pulse.js`.

## Как читать спеки

1. Сначала секции помеченные **v1.0 (implemented)** — это то, что можно проверить в коде и прогнать через `curl`/тесты.
2. **TO BE IMPLEMENTED in v1.1** — договорённости для следующей итерации (например `scriptInline`, webhooks, WS на control-порту).
3. **Open Questions / TO BE DECIDED** — решения, которые должны принять заказчик и NULLXES совместно (порядок старта, один порт vs пул портов, единственный источник webhook и т.д.).


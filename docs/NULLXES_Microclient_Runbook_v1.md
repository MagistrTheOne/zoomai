# NULLXES Zoom Micro-client Runbook (Ubuntu 22.04)

Документ для эксплуатации контура Zoom micro-client (C++) + NULLXES.

---

## 1. Scope

Покрывает операционные шаги:

- install / uninstall
- start / stop / restart
- autostart
- health checks
- recovery после сбоев

Без привязки к конкретной C++ реализации (заказчик пишет клиент).

---

## 2. Предусловия

- Ubuntu 22.04
- Доступ к Zoom account / SDK credentials
- Доступ к OpenAI API key
- Доступ к NULLXES control/text WS endpoints
- Аудиостек:
  - PulseAudio native, или
  - PipeWire с pulse-совместимостью

---

## 3. Installation checklist

1. Установить бинари/зависимости micro-client.
2. Прописать конфиг (host/ports/ws urls/concurrency/audio backend).
3. Подготовить env:
   - `OPENAI_API_KEY`
   - `OPENAI_REALTIME_MODEL` (если требуется)
   - параметры heartbeat/reconnect/backoff
4. Проверить наличие минимум 10 виртуальных input/output audio endpoints.
5. Проверить доступность NULLXES WS:
   - `control`
   - `text`
6. Проверить OpenAI WS connectivity.

---

## 4. Start / Stop / Restart

### Start

- Запустить сервис micro-client.
- Убедиться:
  - активен control WS
  - активен text WS
  - session pool initialized (`N >= 10`)
  - аудио буферы/девайсы готовы

### Stop

- Остановить сервис.
- Для активных сессий:
  - leave Zoom
  - закрыть OpenAI WS
  - освободить аудио буферы
  - вернуть worker в pool

### Restart

- Stop + Start.
- Проверить, что после рестарта pool не содержит "залипших" занятых слотов.

---

## 5. Autostart (systemd guideline)

Рекомендуемый unit lifecycle:

- `Restart=on-failure`
- bounded start timeout
- логирование в journald
- отдельный env file

Операции:

- `systemctl start <service>`
- `systemctl stop <service>`
- `systemctl restart <service>`
- `systemctl enable <service>`
- `systemctl status <service>`

---

## 6. Health checks

Минимальный health contract:

- WS connectivity:
  - control connected
  - text connected
- pool health:
  - `capacity >= 10`
  - `active <= capacity`
- open sessions:
  - каждая сессия имеет валидное состояние FSM
- audio health:
  - capture/write buffers not stalled

---

## 7. Recovery patterns

### A) Control/Text WS dropped

- reconnect with exponential backoff
- при reconnect восстановить heartbeat
- не терять маппинг `aiSystemId -> worker`

### B) OpenAI WS error

- отправить `realtime_error`
- если recoverable: reconnect policy
- если fatal: `meeting_interrupted(error=openai_error)` и release slot

### C) Zoom runtime failure

- `meeting_interrupted(error=zoom_error)`
- cleanup ресурсов
- worker обратно в pool

### D) Audio pipeline fault

- `meeting_interrupted(error=audio_error)`
- reset buffers + reinit device path

---

## 8. Acceptance template (10+ sessions)

- [ ] system boot: pool `N >= 10` ready
- [ ] control/text WS stable under load
- [ ] successful `start_attempt -> meeting_started`
- [ ] correct `unable_to_start` on exhausted pool
- [ ] stable partial/final forwarding for parallel sessions
- [ ] correct `stop_meeting` cleanup
- [ ] no slot leaks after failures/restarts


# NULLXES Integration Pack v1 (Canonical Contract)

Документ фиксирует канонический контракт интеграции для пары:

- `NULLXES AI` (server side)
- `Zoom micro-client (C++)` (client side)

Приоритет: определения полей и типов событий в этом документе выше, чем в диаграммах.

---

## 1. Каналы и роли

Рекомендуемый режим:

- отдельный `control` WebSocket канал (команды/статусы)
- отдельный `text` WebSocket канал (partial/final/error по STT)

`NULLXES` в этом контуре выступает как WebSocket server, micro-client как WS client.

---

## 2. Идентификаторы и общие поля

- `aiSystemId` — UUIDv4 string (control канал)
- `session_id` — UUIDv4 string (text канал)
- `aiSystemId` и `session_id` должны ссылаться на одну и ту же сессию
- `tsMs` — Unix epoch time in ms (number)

Рекомендуется также добавить `seq` (монотонный номер сообщения в рамках сессии) для дедупа/порядка.

---

## 3. Входящие control команды (AI -> micro-client)

### 3.1 `start_attempt`

```json
{
  "eventType": "start_attempt",
  "tsMs": 1744208522000,
  "aiSystemId": "00000000-0000-4000-8000-000000000001",
  "meetingUrl": "https://zoom.us/j/123...?pwd=...",
  "meetingId": "1234567890",
  "passcode": "******",
  "displayName": "NULLXES AI AGENT BOT"
}
```

Минимально обязательные поля для запуска — `eventType`, `tsMs`, `aiSystemId` и согласованный набор zoom-полей (см. раздел 7).

### 3.2 `stop_meeting`

```json
{
  "eventType": "stop_meeting",
  "tsMs": 1744208622000,
  "aiSystemId": "00000000-0000-4000-8000-000000000001"
}
```

---

## 4. Исходящие control команды (micro-client -> AI)

### 4.1 `unable_to_start`

```json
{
  "eventType": "unable_to_start",
  "tsMs": 1744208522100,
  "aiSystemId": "00000000-0000-4000-8000-000000000001",
  "code": "openai_error",
  "details": "openai_ws_connect_timeout"
}
```

`code`:

- `zoom_error`
- `openai_error`
- `audio_error`

### 4.2 `meeting_started`

```json
{
  "eventType": "meeting_started",
  "tsMs": 1744208522600,
  "aiSystemId": "00000000-0000-4000-8000-000000000001"
}
```

### 4.3 `meeting_interrupted`

```json
{
  "eventType": "meeting_interrupted",
  "tsMs": 1744208722600,
  "aiSystemId": "00000000-0000-4000-8000-000000000001",
  "error": "candidate_leaved",
  "details": "participant_left_meeting"
}
```

`error`:

- `candidate_leaved`
- `zoom_error`
- `openai_error`
- `audio_error`

---

## 5. OpenAI Realtime STT (session lifecycle)

### 5.1 Start session

Micro-client в рамках 1 интервью-сессии открывает WS в OpenAI Realtime и отправляет `session.update`:

```json
{
  "type": "session.update",
  "session": {
    "input_audio_format": "pcm16",
    "input_audio_transcription": {
      "model": "gpt-4o-mini-transcribe"
    },
    "turn_detection": {
      "type": "server_vad",
      "threshold": 0.5,
      "prefix_padding_ms": 300,
      "silence_duration_ms": 500
    }
  }
}
```

### 5.2 Audio append

```json
{
  "type": "input_audio_buffer.append",
  "audio": "<base64_pcm16le_mono_24000>"
}
```

Формат входного аудио:

- PCM little-endian 16-bit
- mono
- 24000 Hz
- frame length >= 256 samples (рекомендуемый старт 256/512 сэмплов)

### 5.3 Commit

При `server_vad` commit выполняется OpenAI автоматически.  
Manual fallback при отключенном VAD:

```json
{
  "type": "input_audio_buffer.commit"
}
```

---

## 6. Транзит STT ответов в text канал

Оба события (`delta` и `completed`) передаются транзитом в AI-систему.

### 6.1 `text_partial`

```json
{
  "type": "text_partial",
  "session_id": "00000000-0000-4000-8000-000000000001",
  "tsMs": 1744208523000,
  "payload": {
    "event_id": "event_2122",
    "type": "conversation.item.input_audio_transcription.delta",
    "item_id": "item_003",
    "content_index": 0,
    "delta": "Hello,"
  }
}
```

### 6.2 `text_final`

```json
{
  "type": "text_final",
  "session_id": "00000000-0000-4000-8000-000000000001",
  "tsMs": 1744208523600,
  "payload": {
    "event_id": "event_2123",
    "type": "conversation.item.input_audio_transcription.completed",
    "item_id": "item_003",
    "content_index": 0,
    "transcript": "Hello, how are you?"
  }
}
```

### 6.3 `realtime_error` (рекомендуется)

```json
{
  "type": "realtime_error",
  "session_id": "00000000-0000-4000-8000-000000000001",
  "tsMs": 1744208523650,
  "origin": "openai_realtime",
  "recoverable": true,
  "error": {
    "code": "rate_limit",
    "message": "Realtime rate limit exceeded",
    "event_id": "event_9a2",
    "item_id": "item_003"
  }
}
```

---

## 7. Zoom SDK mapping (TBD inputs from customer backend)

Для `start_attempt` необходимо согласовать точный маппинг полей из Zoom Web API response / backend payload:

- `meetingUrl` (join URL)
- `meetingId`
- `passcode`
- `signature` / `token` (если требуется для Linux Meeting SDK сценария)
- `displayName`

До фиксации backend payload эти поля считаются `TBD`.

Основание:

- Zoom Linux Meeting SDK docs: [Start/Join/Leave](https://developers.zoom.us/docs/meeting-sdk/linux/get-started/meetings/#start-a-meeting)

---

## 8. Матрица ошибок (control)

- До входа во встречу:
  - нет свободного worker/аудио-слота -> `unable_to_start(code=audio_error)`
  - OpenAI WS connect fail -> `unable_to_start(code=openai_error)`
  - Zoom join fail -> `unable_to_start(code=zoom_error)`
- Во время встречи:
  - кандидат ушел -> `meeting_interrupted(error=candidate_leaved)`
  - Zoom runtime error -> `meeting_interrupted(error=zoom_error)`
  - OpenAI runtime error -> `meeting_interrupted(error=openai_error)`
  - audio pipeline fault -> `meeting_interrupted(error=audio_error)`

---

## 9. Принцип обработки partial/final

- `text_partial` используется для UI/индикатора и не считается финальной репликой.
- `text_final` используется как authoritative событие для бизнес-логики.

Итог: контракт partial+final обязателен; partial-only как единственный источник не рекомендуется.

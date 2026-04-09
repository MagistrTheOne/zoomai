# Деплой NULLXES AI Meeting (Docker)

Отдельный production-ориентированный образ от корневого `Dockerfile`: только runtime-зависимости (`npm ci --omit=dev`), без копирования `tests/`, `docs/`, `debug_videos/`.

## Требования

- Docker / Docker Compose v2
- Файл **`.env`** в **корне репозитория** (рядом с `package.json`), минимум `OPENAI_API_KEY`. Шаблон: `.env.example`.

### Частые ошибки (Windows)

1. **`Could not read package.json` / ENOENT** — вы в родительской папке (`NULLXES AI MEETING ZOOM`). Перейдите в каталог проекта:
   ```powershell
   cd NULLXES_AI_AGENT_ZOOM
   ```

2. **`'docker' is not recognized`** — не установлен **Docker Desktop** или не в `PATH`. Установите [Docker Desktop for Windows](https://docs.docker.com/desktop/install/windows-install/), включите WSL2 при необходимости, перезапустите терминал (или ПК). Проверка: `docker version`.

## Сборка образа

Из корня репозитория:

```bash
docker build -f deploy/Dockerfile -t nullxes-ai-meeting:latest .
```

Или:

```bash
npm run docker:deploy:build
```

## Запуск (Compose)

Из корня репозитория:

```bash
docker compose -f deploy/docker-compose.yml up -d
```

Или:

```bash
npm run docker:deploy:up
```

Остановка:

```bash
npm run docker:deploy:down
```

## Порты

| Порт | Назначение |
|------|------------|
| 3000 | Основной HTTP (статика, legacy `/api/*`) |
| 8080 | Control plane (`POST /sessions`, `GET /healthz`, `/metrics`) |
| 47001 | WebSocket захвата микрофона (`AUDIO_CAPTURE_WS_PORT`) |

Порты на хосте можно переопределить переменными `PORT`, `CONTROL_PORT`, `AUDIO_CAPTURE_WS_PORT` в `.env` (Compose подставит в mapping).

## Данные

Транскрипты пишутся в именованный volume **`nullxes_transcripts`** → `/app/transcripts` в контейнере.

## Chromium / память

В Compose задано **`shm_size: 2gb`** — снижает краши вкладок Playwright/Chromium.

## Проверка

```bash
curl -sS http://localhost:8080/healthz
```

## Отличие от корневого `Dockerfile`

| | Корневой `Dockerfile` | `deploy/Dockerfile` |
|---|------------------------|---------------------|
| Установка | `npm install` (все deps) | `npm ci --omit=dev` |
| Копирование | весь контекст `COPY . .` | только `src` (включая `src/public`), `examples`, нужные файлы |
| Назначение | разработка / legacy `docker:build` | прод-деплой |

Образ Playwright тот же (`mcr.microsoft.com/playwright:v1.54.1-jammy`), entrypoint с Pulse — как в основном образе.

## Документы для micro-client handoff

Для контура C++ Zoom micro-client и разделов 7–10 ТЗ используйте:

- `docs/NULLXES_Integration_Pack_v1.md` (канонические контракты payload/events)
- `docs/NULLXES_Microclient_Integration_v1.md` (архитектура и WS-модель)
- `docs/NULLXES_Microclient_Runbook_v1.md` (install/start/stop/restart/autostart runbook)
- `docs/NULLXES_Microclient_Handoff_v1.md` (PDF-friendly master bundle)

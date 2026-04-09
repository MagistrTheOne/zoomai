# NULLXES AI Meeting — workspace

Исходный код и `package.json` лежат в подпапке **`NULLXES_AI_AGENT_ZOOM`**.

```powershell
cd NULLXES_AI_AGENT_ZOOM
npm install
npm test
```

Сборка Docker-образа деплоя — только из этой папки; нужен установленный **Docker Desktop** (или другой Docker CLI в `PATH`).

```powershell
cd NULLXES_AI_AGENT_ZOOM
npm run docker:deploy:build
```

Подробности: `NULLXES_AI_AGENT_ZOOM/deploy/README.md`.

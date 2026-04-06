const { spawnSync } = require("child_process");
const path = require("path");
const {
  resolveDockerExecutable,
  envWithDockerResourcesInPath,
} = require("../src/backend/docker_resolve");

const docker = resolveDockerExecutable();
const root = path.join(__dirname, "..");

const result = spawnSync(docker, ["build", "-t", "zoom-bot", "."], {
  cwd: root,
  stdio: "inherit",
  env: envWithDockerResourcesInPath(),
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);

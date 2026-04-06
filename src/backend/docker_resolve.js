const fs = require("fs");
const path = require("path");

/**
 * Path to the Docker CLI. Uses DOCKER_PATH if set and valid; on Windows
 * falls back to Docker Desktop's default install when `docker` is not on PATH.
 */
function resolveDockerExecutable() {
  const fromEnv = process.env.DOCKER_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const candidate = path.join(
      programFiles,
      "Docker",
      "Docker",
      "resources",
      "bin",
      "docker.exe"
    );
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "docker";
}

/**
 * Docker Desktop installs helpers (e.g. docker-credential-desktop) next to docker.exe.
 * Child processes spawned by Node often lack that folder on PATH, which breaks
 * `docker run` / pulls with: "docker-credential-desktop: executable file not found".
 */
function dockerResourcesBinDir() {
  if (process.platform !== "win32") {
    return null;
  }
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const dir = path.join(
    programFiles,
    "Docker",
    "Docker",
    "resources",
    "bin"
  );
  return fs.existsSync(dir) ? dir : null;
}

function envWithDockerResourcesInPath() {
  const env = { ...process.env };
  const dir = dockerResourcesBinDir();
  if (dir) {
    const sep = path.delimiter;
    env.PATH = `${dir}${sep}${env.PATH || ""}`;
  }
  return env;
}

module.exports = {
  resolveDockerExecutable,
  envWithDockerResourcesInPath,
};

// Builds the complete Linger V2 per-service signed upgrade test kit:
//   - step-00-baseline        (0.1.10-v2test.0) : baseline 7 bundles
//   - step-01-web             (0.1.10-v2test.1) : ONLY web changed (visible V2 badge, 0-downtime hot reload)
//   - step-02-skills-prompts  (0.1.10-v2test.2) : ONLY skills-prompts changed (0-downtime silent hot reload)
//   - step-03-node-services   (0.1.10-v2test.3) : ONLY node-services/voice-runtime changed (partial restart + drain)
//   - step-04-teamhub         (0.1.10-v2test.4) : ONLY teamhub Go binaries changed (3-platform signed)
//   - step-05-computer-daemon (0.1.10-v2test.5) : ONLY computer-daemon + teamhub-cli changed (3-platform signed)
//   - step-06-installer       (0.1.10-v2test.6) : ONLY installer changed (noarch)
//   - step-07-rollback-faulty (0.1.10-v2test.7) : ONLY faulty signed teamhub (rollbackSafe:false -> auto rollback + denylist)
//
// Every step's Schema 3 `app-manifest.json` strictly inherits all 6 unchanged
// modules' exact `artifactId`, `sha256`, `inputHash`, `originAppVersion`, and
// `url`, and is Ed25519-signed with `DESKTOP_UPDATE_KEY_PEM` (verified against
// `UPDATE_PUBLIC_KEY` in `apps/desktop/src/main/update-manifest.ts`).
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  packDeterministicTarZst,
  sha256File,
  writeSignedManifestV3,
} from "./build-app-bundles.mjs";
import {
  BUNDLE_IDS,
  PLATFORM_TARGETS,
  computeNativeDepsHash,
} from "./compute-bundle-inputs.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptsDir, "..");
const defaultRepoRoot = path.resolve(desktopDir, "../..");

export function deriveStepVersions(baseVersion = "0.1.10-v2test.0") {
  const match = /^(\d+\.\d+\.\d+)(?:-([A-Za-z0-9-]+)(?:\.(\d+))?)?$/.exec(
    baseVersion,
  );
  if (!match) {
    throw new Error(`Invalid baseVersion: ${baseVersion}`);
  }
  const core = match[1];
  const preTag = match[2] || "v2test";
  const startNum = match[3] !== undefined ? Number(match[3]) : 0;
  const v = (offset) => `${core}-${preTag}.${startNum + offset}`;
  return {
    "step-00-baseline": baseVersion,
    "step-01-web": v(1),
    "step-02-skills-prompts": v(2),
    "step-03-node-services": v(3),
    "step-04-teamhub": v(4),
    "step-05-computer-daemon": v(5),
    "step-06-installer": v(6),
    "step-07-rollback-faulty": v(7),
  };
}

export const STEP_DEFINITIONS = Object.freeze([
  {
    id: "step-00-baseline",
    changedModules: [...BUNDLE_IDS],
    updateBehavior: "Initial V2 Store seed (all 7 bundles baseline)",
    rollbackSafe: true,
    dbSchemaEpoch: 892,
  },
  {
    id: "step-01-web",
    changedModules: ["web"],
    updateBehavior: "0-downtime Web static-host hot reload + visible V2 badge (6/7 skipped)",
    rollbackSafe: true,
    dbSchemaEpoch: 892,
  },
  {
    id: "step-02-skills-prompts",
    changedModules: ["skills-prompts"],
    updateBehavior: "0-downtime silent Skills/Prompts hot reload (6/7 skipped)",
    rollbackSafe: true,
    dbSchemaEpoch: 892,
  },
  {
    id: "step-03-node-services",
    changedModules: ["node-services"],
    updateBehavior: "Partial node-services/voice-runtime restart + active drain protection (6/7 skipped)",
    rollbackSafe: true,
    dbSchemaEpoch: 892,
  },
  {
    id: "step-04-teamhub",
    changedModules: ["teamhub"],
    updateBehavior: "Signed Go TeamHub rolling upgrade (PG/LiveKit/Electron 0 restart, 6/7 skipped)",
    rollbackSafe: true,
    dbSchemaEpoch: 892,
  },
  {
    id: "step-05-computer-daemon",
    changedModules: ["computer-daemon"],
    updateBehavior: "Signed Go Computer Daemon + teamhub-cli idle-drain hot swap (6/7 skipped)",
    rollbackSafe: true,
    dbSchemaEpoch: 892,
  },
  {
    id: "step-06-installer",
    changedModules: ["installer"],
    updateBehavior: "Noarch installer-only incremental update (6/7 skipped)",
    rollbackSafe: true,
    dbSchemaEpoch: 892,
  },
  {
    id: "step-07-rollback-faulty",
    changedModules: ["teamhub"],
    updateBehavior: "Faulty signed TeamHub (rollbackSafe:false) -> pg_dump/pg_restore + auto-rollback to step-06 + denylist",
    rollbackSafe: false,
    dbSchemaEpoch: 893,
  },
]);

function sha256String(text) {
  return createHash("sha256").update(text).digest("hex");
}

function makeArtifactUrl(baseUrl, bundleId, fileName) {
  const rel = `bundles/${bundleId}/${fileName}`;
  if (!baseUrl || baseUrl === "relative") return rel;
  return `${baseUrl.replace(/\/+$/, "")}/${rel}`;
}

function signedKindFor(target, { macosSigned, windowsSigned }) {
  if (target.startsWith("darwin-")) return macosSigned ? "developer-id" : "none";
  if (target.startsWith("win32-")) return windowsSigned ? "authenticode" : "none";
  return "none";
}

async function copyIfExists(src, dest) {
  if (!src || !existsSync(src)) return false;
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
  return true;
}

function injectWebBanner(html, version, stepId) {
  const banner =
    `\n<!-- LINGER_V2_TEST_BANNER:${stepId}:${version} -->\n` +
    `<div id="linger-v2-upgrade-banner" data-v2-step="${stepId}" data-v2-version="${version}" ` +
    `style="position:fixed;bottom:10px;right:12px;z-index:2147483647;background:rgba(15,23,42,0.92);` +
    `color:#38bdf8;border:1px solid #0284c7;border-radius:999px;padding:4px 12px;` +
    `font:600 12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;` +
    `box-shadow:0 4px 14px rgba(0,0,0,0.35);pointer-events:none;">` +
    `Linger V2 Test · ${stepId} · ${version}</div>\n`;
  if (html.includes("</body>")) {
    return html.replace("</body>", `${banner}</body>`);
  }
  return `${html}${banner}`;
}

async function stageWebDir(workDir, { webDistDir, version, stepId, injectBanner, staticHostSrc }) {
  const stage = path.join(workDir, `web-${stepId}`);
  const distDest = path.join(stage, "dist");
  await mkdir(distDest, { recursive: true });
  const copied = await copyIfExists(webDistDir, distDest);
  if (!copied || !existsSync(path.join(distDest, "index.html"))) {
    await writeFile(
      path.join(distDest, "index.html"),
      `<!doctype html><html><head><meta charset="utf-8"><title>Linger Web ${version}</title></head>` +
        `<body><main id="root"><h1>Linger Web ${version}</h1></main></body></html>\n`,
      "utf8",
    );
  }
  if (injectBanner) {
    const indexPath = path.join(distDest, "index.html");
    const html = await readFile(indexPath, "utf8");
    await writeFile(indexPath, injectWebBanner(html, version, stepId), "utf8");
  }
  if (staticHostSrc && existsSync(staticHostSrc)) {
    await cp(staticHostSrc, path.join(stage, "static-host.mjs"));
  }
  await writeFile(
    path.join(stage, "v2-service-version.json"),
    `${JSON.stringify({ module: "web", stepId, appVersion: version }, null, 2)}\n`,
    "utf8",
  );
  return stage;
}

async function stageSkillsPromptsDir(workDir, { repoRoot, version, stepId, addProbeSkill }) {
  const stage = path.join(workDir, `skills-prompts-${stepId}`);
  await mkdir(path.join(stage, "skills"), { recursive: true });
  await mkdir(path.join(stage, "prompts"), { recursive: true });
  await copyIfExists(path.join(repoRoot, "skills/builtin"), path.join(stage, "skills"));
  await copyIfExists(path.join(repoRoot, "apps/node-services/prompts"), path.join(stage, "prompts"));
  if (addProbeSkill) {
    const probeDir = path.join(stage, "skills/v2-upgrade-probe");
    await mkdir(probeDir, { recursive: true });
    await writeFile(
      path.join(probeDir, "SKILL.md"),
      `---\nname: v2-upgrade-probe\ndescription: Marker skill installed by Linger V2 ${stepId} (${version}) to prove 0-downtime skills-prompts hot reload.\n---\n\n` +
        `# Linger V2 Skills Upgrade Marker\n\n- Step: \`${stepId}\`\n- App Version: \`${version}\`\n`,
      "utf8",
    );
    await writeFile(
      path.join(stage, "prompts/v2-upgrade-marker.txt"),
      `LINGER_V2_PROMPTS_MARKER step=${stepId} version=${version}\n`,
      "utf8",
    );
  }
  await writeFile(
    path.join(stage, "v2-service-version.json"),
    `${JSON.stringify({ module: "skills-prompts", stepId, appVersion: version }, null, 2)}\n`,
    "utf8",
  );
  return stage;
}

async function stageNodeServicesDir(workDir, { nodeServicesDir, version, stepId }) {
  const stage = path.join(workDir, `node-services-${stepId}`);
  await mkdir(stage, { recursive: true });
  const copied = await copyIfExists(nodeServicesDir, stage);
  if (!copied) {
    await writeFile(
      path.join(stage, "package.json"),
      `${JSON.stringify({ name: "@linger/node-services", private: true, type: "module", version }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(stage, "voice-runtime.mjs"),
      `import http from "node:http";\n` +
        `const port = Number(process.env.LINGER_VOICE_RUNTIME_PORT || 0);\n` +
        `const version = ${JSON.stringify(version)};\n` +
        `const server = http.createServer((req, res) => {\n` +
        `  if (req.url === "/healthz") {\n` +
        `    res.writeHead(200, { "content-type": "application/json" });\n` +
        `    res.end(JSON.stringify({ ok: true, livekitReachable: true, service: "voice-runtime", version, stepId: ${JSON.stringify(stepId)} }));\n` +
        `    return;\n` +
        `  }\n` +
        `  if (req.url === "/v1/voice/active") {\n` +
        `    res.writeHead(200, { "content-type": "application/json" });\n` +
        `    res.end(JSON.stringify({ activeSessions: 0, version }));\n` +
        `    return;\n` +
        `  }\n` +
        `  res.writeHead(404); res.end("not found");\n` +
        `});\n` +
        `if (port > 0) server.listen(port, "127.0.0.1");\n`,
      "utf8",
    );
  }
  await writeFile(
    path.join(stage, "v2-service-version.json"),
    `${JSON.stringify({ module: "node-services", stepId, appVersion: version }, null, 2)}\n`,
    "utf8",
  );
  return stage;
}

async function stageNodeNativeDepsDir(workDir, { nodeNativeDepsDir, target, version }) {
  const stage = path.join(workDir, `node-native-deps-${target}`);
  await mkdir(stage, { recursive: true });
  const src = nodeNativeDepsDir ? path.join(nodeNativeDepsDir, target) : null;
  const copied = await copyIfExists(src, stage);
  if (!copied) {
    await mkdir(path.join(stage, "node_modules"), { recursive: true });
    await writeFile(
      path.join(stage, "node-native-deps-manifest.json"),
      `${JSON.stringify({ target, appVersion: version, layout: "shared-node-deps" }, null, 2)}\n`,
      "utf8",
    );
  }
  return stage;
}

async function stageInstallerDir(workDir, { installerDistDir, version, stepId }) {
  const stage = path.join(workDir, `installer-${stepId}`);
  await mkdir(stage, { recursive: true });
  const copied = await copyIfExists(installerDistDir, stage);
  if (!copied) {
    await writeFile(
      path.join(stage, "index.mjs"),
      `export const installerVersion = ${JSON.stringify(version)};\n`,
      "utf8",
    );
  }
  await writeFile(
    path.join(stage, "v2-service-version.json"),
    `${JSON.stringify({ module: "installer", stepId, appVersion: version }, null, 2)}\n`,
    "utf8",
  );
  return stage;
}

async function stageTargetBinaryBundle(
  workDir,
  { moduleId, srcRoot, target, version, stepId, extraDir = null, extraSubdir = null, faulty = false },
) {
  const stage = path.join(workDir, `${moduleId}-${stepId}-${target}`);
  await mkdir(stage, { recursive: true });
  const src = srcRoot ? path.join(srcRoot, target) : null;
  const copied = await copyIfExists(src, stage);
  if (!copied) {
    const exe = (name) => (target.startsWith("win32-") ? `${name}.exe` : name);
    if (moduleId === "teamhub") {
      const script = faulty
        ? `#!/bin/sh\necho "[V2-TEST-FAULTY-${version}] simulated startup failure for rollback verification" >&2\nexit 42\n`
        : `#!/bin/sh\necho "teamhub ${version} (${stepId}, ${target})"\n`;
      for (const cmd of ["teamhub", "migrate", "account"]) {
        const file = path.join(stage, exe(cmd));
        await writeFile(file, cmd === "teamhub" ? script : `#!/bin/sh\necho "${cmd} ${version}"\n`, "utf8");
        await chmod(file, 0o755);
      }
    } else if (moduleId === "computer-daemon") {
      const file = path.join(stage, exe("linger-computer-daemon"));
      await writeFile(file, `#!/bin/sh\necho "linger-computer-daemon ${version} (${stepId}, ${target})"\n`, "utf8");
      await chmod(file, 0o755);
    }
  }
  if (extraDir && extraSubdir) {
    await copyIfExists(extraDir, path.join(stage, extraSubdir));
  }
  await writeFile(
    path.join(stage, "v2-service-version.json"),
    `${JSON.stringify({ module: moduleId, target, stepId, appVersion: version, faulty }, null, 2)}\n`,
    "utf8",
  );
  return stage;
}

function buildTestGuideMarkdown({
  baseVersion,
  versions,
  baseUrl,
  targets,
  macosSigned,
  windowsSigned,
  signedWith,
}) {
  const isPortable = !baseUrl || baseUrl === "relative";
  return `# Linger V2 Real-Device Signed Upgrade Test Guide

This test kit was built by GitHub Actions (\`v2-signed-test-pack.yml\`, **non-release workflow_dispatch Artifact only** — no GitHub Release or tag was published).

- **Baseline Installer Version**: \`${baseVersion}\`
- **Target Platforms**: ${targets.map((t) => `\`${t}\``).join(", ")}
- **Manifest Ed25519 Key**: \`${signedWith}\`
- **macOS Binary Code Signing**: \`${macosSigned ? "Developer ID (rcodesign + hardened runtime)" : "unsigned / dry-run"}\`
- **Windows Binary Code Signing**: \`${windowsSigned ? "Authenticode (osslsigncode)" : "unsigned / dry-run"}\`
- **Manifest URL Mode**: \`${isPortable ? "portable feed-relative (works on any localhost / LAN / HTTPS tunnel without re-signing)" : baseUrl}\`

---

## 1. Download Artifacts from GitHub Actions

From the GitHub Actions Run page (**Artifacts** section at the bottom):

1. Download the signed baseline installer for your machine:
   - **macOS (Apple Silicon)**: \`v2-test-installer-macos-arm64\` → \`Linger-${baseVersion}-macos-arm64.dmg\`
   - **Windows x64**: \`v2-test-installer-windows-x64\` → \`Linger-${baseVersion}-windows-x64-setup.exe\`
   - **Linux x64**: \`v2-test-installer-linux-x64\` → \`Linger-${baseVersion}-linux-x64.tar.gz\`
2. Download the per-service upgrade pack bundle (shared across all 3 platforms):
   - \`v2-test-service-upgrade-packs\` → unzip into any local folder (e.g. \`~/linger-v2-test-packs/\`).

---

## 2. Start the Local Test Feed Server

\`\`\`bash
cd ~/linger-v2-test-packs
node serve-test-feed.mjs --step 00 --port 8787
\`\`\`

- Open **http://127.0.0.1:8787** in your browser to use the interactive Step Control Panel (or type \`00\`..\`07\` + Enter in the terminal).
- For **multi-device LAN HTTPS testing**, run:
  \`\`\`bash
  node serve-test-feed.mjs --step 00 --host 0.0.0.0 --port 8443 --https
  \`\`\`
  (or point any HTTPS reverse proxy / \`cloudflared tunnel --url http://127.0.0.1:8787\` at the local server — because the signed manifests use feed-relative bundle paths, the **exact CI-signed Ed25519 signature stays 100% valid on any URL**!).

---

## 3. Launch the Installed Signed Client Against the Test Feed

> **Note**: Ed25519 signature verification against Linger's built-in \`UPDATE_PUBLIC_KEY\` and SHA-256 verification on every \`.tar.zst\` bundle remain **100% enforced**. \`LINGER_ALLOW_LOOPBACK_TEST_FEED=1\` only permits \`http://127.0.0.1\` / \`http://localhost\` loopback transport.

### macOS
\`\`\`bash
LINGER_ALLOW_LOOPBACK_TEST_FEED=1 \\
LINGER_UPDATE_FEED_URL=http://127.0.0.1:8787 \\
LINGER_BUNDLE_CHECK_DELAY_MS=3000 \\
LINGER_BUNDLE_CHECK_INTERVAL_MS=10000 \\
/Applications/Linger.app/Contents/MacOS/Linger
\`\`\`

### Windows (PowerShell)
\`\`\`powershell
$env:LINGER_ALLOW_LOOPBACK_TEST_FEED = "1"
$env:LINGER_UPDATE_FEED_URL = "http://127.0.0.1:8787"
$env:LINGER_BUNDLE_CHECK_DELAY_MS = "3000"
$env:LINGER_BUNDLE_CHECK_INTERVAL_MS = "10000"
& "$env:LOCALAPPDATA\\Programs\\Linger\\Linger.exe"
\`\`\`

### Linux
\`\`\`bash
LINGER_ALLOW_LOOPBACK_TEST_FEED=1 \\
LINGER_UPDATE_FEED_URL=http://127.0.0.1:8787 \\
LINGER_BUNDLE_CHECK_DELAY_MS=3000 \\
LINGER_BUNDLE_CHECK_INTERVAL_MS=10000 \\
./Linger-${baseVersion}-linux-x64/linger
\`\`\`

---

## 4. Step-by-Step Real-Device Verification Matrix

| Step | Version | Changed Bundle | What to Observe |
|---|---|---|---|
| \`step-00-baseline\` | \`${versions["step-00-baseline"]}\` | All 7 (initial seed) | Seeds \`<LINGER_HOME>/store/\` with baseline bundles so steps 01–07 download **only 1/7 changed bundle**. |
| \`step-01-web\` | \`${versions["step-01-web"]}\` | **ONLY \`web\`** | Feed log shows **only \`bundles/web/...\` downloaded** (6/7 skipped). Web UI hot-reloads with bottom-right pill **\`Linger V2 Test · step-01-web · ${versions["step-01-web"]}\`**. PG / TeamHub / LiveKit / Electron PIDs do NOT change. |
| \`step-02-skills-prompts\` | \`${versions["step-02-skills-prompts"]}\` | **ONLY \`skills-prompts\`** | Feed log shows **only \`bundles/skills-prompts/...\` downloaded**. Commits silently with 0 downtime; \`store/skills-prompts/.../skills/v2-upgrade-probe/SKILL.md\` appears on disk. |
| \`step-03-node-services\` | \`${versions["step-03-node-services"]}\` | **ONLY \`node-services\`** | Feed log shows **only \`bundles/node-services/...\` downloaded**. If an Agent task or voice session is active, enters \`waiting\` (drain protection) until idle, then restarts only node-services / voice-runtime. |
| \`step-04-teamhub\` | \`${versions["step-04-teamhub"]}\` | **ONLY \`teamhub\`** | Feed log shows **only \`bundles/teamhub/teamhub-<target>-...\` downloaded**. macOS Gatekeeper / Windows Authenticode accepts the signed binary; TeamHub rolling-restarts while PG, LiveKit & Electron stay alive. |
| \`step-05-computer-daemon\` | \`${versions["step-05-computer-daemon"]}\` | **ONLY \`computer-daemon\`** | Feed log shows **only \`bundles/computer-daemon/...\` downloaded**. Waits for running agent tasks = 0, swaps to signed \`${versions["step-05-computer-daemon"]}\` daemon + \`teamhub-cli\`, and reconnects. |
| \`step-06-installer\` | \`${versions["step-06-installer"]}\` | **ONLY \`installer\`** | Feed log shows **only \`bundles/installer/...\` downloaded** (6/7 skipped). Commits \`${versions["step-06-installer"]}\`. |
| \`step-07-rollback-faulty\` | \`${versions["step-07-rollback-faulty"]}\` | **ONLY faulty \`teamhub\`** (\`rollbackSafe: false\`) | Pre-migration \`pg_dump\` runs → faulty signed \`teamhub\` exits with code \`42\` → HealthWatchdog triggers \`pg_restore\` + automatic rollback to \`${versions["step-06-installer"]}\` → \`${versions["step-07-rollback-faulty"]}\` is written to \`state/denylist.json\` → subsequent checks skip it (no update loop!). |
`;
}

export async function buildV2TestUpgradePacks({
  repoRoot = defaultRepoRoot,
  outDir,
  baseVersion = "0.1.10-v2test.0",
  channel = "stable",
  baseUrl = "relative",
  targets = [...PLATFORM_TARGETS],
  privateKeyPem = null,
  expectedPublicKeyPem = null,
  ephemeralTestKey = false,
  webDistDir = null,
  installerDistDir = null,
  nodeServicesDir = null,
  nodeNativeDepsDir = null,
  teamhubDir = null,
  teamhubV2Dir = null,
  teamhubFaultyDir = null,
  daemonDir = null,
  daemonV2Dir = null,
  teamhubCliDir = null,
  macosSigned = false,
  windowsSigned = false,
  minShellVersion = null,
} = {}) {
  if (!outDir) throw new Error("outDir is required");
  const absOut = path.resolve(outDir);
  await rm(absOut, { recursive: true, force: true });
  await mkdir(path.join(absOut, "bundles"), { recursive: true });
  await mkdir(path.join(absOut, "steps"), { recursive: true });

  let signingPrivateKeyPem = privateKeyPem;
  let verifyPublicKeyPem = expectedPublicKeyPem;
  let signedWith = "unsigned";

  if (ephemeralTestKey && !signingPrivateKeyPem) {
    const pair = generateKeyPairSync("ed25519");
    signingPrivateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    verifyPublicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    await writeFile(path.join(absOut, "test-public-key.pem"), verifyPublicKeyPem, "utf8");
    signedWith = "ephemeral-ed25519-test-key";
  } else if (signingPrivateKeyPem) {
    signedWith = "DESKTOP_UPDATE_KEY_PEM";
    if (!verifyPublicKeyPem) {
      verifyPublicKeyPem = createPublicKey(signingPrivateKeyPem)
        .export({ type: "spki", format: "pem" })
        .toString();
    }
  }

  const versions = deriveStepVersions(baseVersion);
  const lockfilePath = path.join(repoRoot, "pnpm-lock.yaml");
  const lockfileText = existsSync(lockfilePath) ? await readFile(lockfilePath, "utf8") : "";
  const nativeDepsInfo = computeNativeDepsHash(lockfileText, { target: "all", nodeMajor: "26" });
  // Keep minShellVersion <= baseVersion (never strip prerelease suffix, since in
  // SemVer 0.1.10-v2test.0 < 0.1.10 which would wrongly trigger shell-upgrade-required).
  const effectiveMinShell = minShellVersion ?? baseVersion;
  const staticHostSrc = path.join(repoRoot, "apps/web/static-host.mjs");

  const work = await mkdtemp(path.join(tmpdir(), "linger-v2-test-kit-"));
  const checksumFiles = [];
  const stepSummaries = [];

  try {
    const packNoarch = async (bundleId, stageDir, originAppVersion) => {
      const destDir = path.join(absOut, "bundles", bundleId);
      const packed = await packDeterministicTarZst(stageDir, destDir, bundleId);
      checksumFiles.push({ rel: `bundles/${bundleId}/${packed.fileName}`, sha256: packed.sha256 });
      return {
        arch: "noarch",
        originAppVersion,
        inputHash: sha256String(`${bundleId}:${originAppVersion}:${packed.sha256}`),
        ...(bundleId === "node-services" ? { nativeDepsHash: nativeDepsInfo.hash } : {}),
        artifact: {
          artifactId: packed.artifactId,
          format: "tar.zst",
          url: makeArtifactUrl(baseUrl, bundleId, packed.fileName),
          sha256: packed.sha256,
          size: packed.size,
        },
      };
    };

    const packPerTarget = async (bundleId, stageByTarget, originAppVersion) => {
      const destDir = path.join(absOut, "bundles", bundleId);
      const targetEntries = {};
      const hashParts = [];
      for (const target of targets) {
        const packed = await packDeterministicTarZst(
          stageByTarget[target],
          destDir,
          bundleId,
          target,
        );
        checksumFiles.push({ rel: `bundles/${bundleId}/${packed.fileName}`, sha256: packed.sha256 });
        hashParts.push(`${target}:${packed.sha256}`);
        const signed =
          bundleId === "teamhub" || bundleId === "computer-daemon"
            ? signedKindFor(target, { macosSigned, windowsSigned })
            : undefined;
        targetEntries[target] = {
          artifactId: packed.artifactId,
          format: "tar.zst",
          url: makeArtifactUrl(baseUrl, bundleId, packed.fileName),
          sha256: packed.sha256,
          size: packed.size,
          ...(signed ? { signed } : {}),
        };
      }
      return {
        arch: "per-target",
        originAppVersion,
        inputHash: sha256String(`${bundleId}:${originAppVersion}:${hashParts.join("|")}`),
        targets: targetEntries,
      };
    };

    // --- Step 00: Baseline (all 7 bundles) ---
    const v0 = versions["step-00-baseline"];
    const baselineBundles = {};

    baselineBundles.web = await packNoarch(
      "web",
      await stageWebDir(work, {
        webDistDir: webDistDir ?? path.join(repoRoot, "apps/web/dist"),
        version: v0,
        stepId: "step-00-baseline",
        injectBanner: false,
        staticHostSrc,
      }),
      v0,
    );

    baselineBundles["skills-prompts"] = await packNoarch(
      "skills-prompts",
      await stageSkillsPromptsDir(work, {
        repoRoot,
        version: v0,
        stepId: "step-00-baseline",
        addProbeSkill: false,
      }),
      v0,
    );

    baselineBundles["node-services"] = await packNoarch(
      "node-services",
      await stageNodeServicesDir(work, {
        nodeServicesDir,
        version: v0,
        stepId: "step-00-baseline",
      }),
      v0,
    );

    const nativeDepsStages = {};
    for (const target of targets) {
      nativeDepsStages[target] = await stageNodeNativeDepsDir(work, {
        nodeNativeDepsDir,
        target,
        version: v0,
      });
    }
    baselineBundles["node-native-deps"] = await packPerTarget(
      "node-native-deps",
      nativeDepsStages,
      v0,
    );

    const teamhubV0Stages = {};
    const daemonV0Stages = {};
    for (const target of targets) {
      teamhubV0Stages[target] = await stageTargetBinaryBundle(work, {
        moduleId: "teamhub",
        srcRoot: teamhubDir,
        target,
        version: v0,
        stepId: "step-00-baseline",
      });
      daemonV0Stages[target] = await stageTargetBinaryBundle(work, {
        moduleId: "computer-daemon",
        srcRoot: daemonDir,
        target,
        version: v0,
        stepId: "step-00-baseline",
        extraDir: teamhubCliDir,
        extraSubdir: "teamhub-cli",
      });
    }
    baselineBundles.teamhub = await packPerTarget("teamhub", teamhubV0Stages, v0);
    baselineBundles["computer-daemon"] = await packPerTarget("computer-daemon", daemonV0Stages, v0);

    baselineBundles.installer = await packNoarch(
      "installer",
      await stageInstallerDir(work, {
        installerDistDir: installerDistDir ?? path.join(repoRoot, "apps/linger-installer/dist"),
        version: v0,
        stepId: "step-00-baseline",
      }),
      v0,
    );

    // Helper that clones previous step's bundles and replaces ONLY the specified bundle(s)
    const manifestsByStep = {};
    const writeStep = async (def, bundles) => {
      const appVersion = versions[def.id];
      const manifest = {
        schema: 3,
        channel,
        releaseId: `${appVersion}-${def.id}`,
        appVersion,
        publishedAt: new Date().toISOString(),
        rollout: { percent: 100 },
        compat: {
          minShellVersion: effectiveMinShell,
          minNativeDepsHash: nativeDepsInfo.hash,
          runnerGatewayProtocol: 1,
          dbSchemaEpoch: def.dbSchemaEpoch,
          rollbackSafe: def.rollbackSafe,
        },
        bundles,
      };
      const stepOut = path.join(absOut, "steps", def.id);
      const written = await writeSignedManifestV3(stepOut, manifest, {
        privateKeyPem: signingPrivateKeyPem,
        expectedPublicKeyPem: signingPrivateKeyPem ? verifyPublicKeyPem : null,
      });
      checksumFiles.push({
        rel: `steps/${def.id}/app-manifest.json`,
        sha256: await sha256File(written.manifestPath),
      });
      if (written.signaturePath) {
        checksumFiles.push({
          rel: `steps/${def.id}/app-manifest.json.sig`,
          sha256: await sha256File(written.signaturePath),
        });
      }

      const changedSizes = {};
      for (const modId of def.changedModules) {
        const entry = bundles[modId];
        if (entry.arch === "noarch") {
          changedSizes[modId] = entry.artifact.size;
        } else {
          changedSizes[modId] = Object.fromEntries(
            Object.entries(entry.targets).map(([t, a]) => [t, a.size]),
          );
        }
      }
      const summary = {
        id: def.id,
        appVersion,
        changedModules: def.changedModules,
        inheritedModules: BUNDLE_IDS.filter((id) => !def.changedModules.includes(id)),
        rollbackSafe: def.rollbackSafe,
        dbSchemaEpoch: def.dbSchemaEpoch,
        updateBehavior: def.updateBehavior,
        changedSizes,
        signed: Boolean(written.signaturePath),
      };
      await writeFile(
        path.join(stepOut, "summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
        "utf8",
      );
      manifestsByStep[def.id] = manifest;
      stepSummaries.push(summary);
      return manifest;
    };

    let prevBundles = baselineBundles;
    await writeStep(STEP_DEFINITIONS[0], prevBundles);

    // --- Step 01: web only ---
    {
      const def = STEP_DEFINITIONS[1];
      const ver = versions[def.id];
      const next = structuredClone(prevBundles);
      next.web = await packNoarch(
        "web",
        await stageWebDir(work, {
          webDistDir: webDistDir ?? path.join(repoRoot, "apps/web/dist"),
          version: ver,
          stepId: def.id,
          injectBanner: true,
          staticHostSrc,
        }),
        ver,
      );
      await writeStep(def, next);
      prevBundles = next;
    }

    // --- Step 02: skills-prompts only ---
    {
      const def = STEP_DEFINITIONS[2];
      const ver = versions[def.id];
      const next = structuredClone(prevBundles);
      next["skills-prompts"] = await packNoarch(
        "skills-prompts",
        await stageSkillsPromptsDir(work, {
          repoRoot,
          version: ver,
          stepId: def.id,
          addProbeSkill: true,
        }),
        ver,
      );
      await writeStep(def, next);
      prevBundles = next;
    }

    // --- Step 03: node-services only ---
    {
      const def = STEP_DEFINITIONS[3];
      const ver = versions[def.id];
      const next = structuredClone(prevBundles);
      next["node-services"] = await packNoarch(
        "node-services",
        await stageNodeServicesDir(work, {
          nodeServicesDir,
          version: ver,
          stepId: def.id,
        }),
        ver,
      );
      await writeStep(def, next);
      prevBundles = next;
    }

    // --- Step 04: teamhub only (3-platform signed) ---
    {
      const def = STEP_DEFINITIONS[4];
      const ver = versions[def.id];
      const next = structuredClone(prevBundles);
      const stages = {};
      for (const target of targets) {
        stages[target] = await stageTargetBinaryBundle(work, {
          moduleId: "teamhub",
          srcRoot: teamhubV2Dir ?? teamhubDir,
          target,
          version: ver,
          stepId: def.id,
        });
      }
      next.teamhub = await packPerTarget("teamhub", stages, ver);
      await writeStep(def, next);
      prevBundles = next;
    }

    // --- Step 05: computer-daemon + teamhub-cli only (3-platform signed) ---
    {
      const def = STEP_DEFINITIONS[5];
      const ver = versions[def.id];
      const next = structuredClone(prevBundles);
      const stages = {};
      for (const target of targets) {
        stages[target] = await stageTargetBinaryBundle(work, {
          moduleId: "computer-daemon",
          srcRoot: daemonV2Dir ?? daemonDir,
          target,
          version: ver,
          stepId: def.id,
          extraDir: teamhubCliDir,
          extraSubdir: "teamhub-cli",
        });
      }
      next["computer-daemon"] = await packPerTarget("computer-daemon", stages, ver);
      await writeStep(def, next);
      prevBundles = next;
    }

    // --- Step 06: installer only (noarch) ---
    {
      const def = STEP_DEFINITIONS[6];
      const ver = versions[def.id];
      const next = structuredClone(prevBundles);
      next.installer = await packNoarch(
        "installer",
        await stageInstallerDir(work, {
          installerDistDir: installerDistDir ?? path.join(repoRoot, "apps/linger-installer/dist"),
          version: ver,
          stepId: def.id,
        }),
        ver,
      );
      await writeStep(def, next);
      prevBundles = next;
    }

    // --- Step 07: faulty signed teamhub (rollbackSafe: false) ---
    {
      const def = STEP_DEFINITIONS[7];
      const ver = versions[def.id];
      const next = structuredClone(prevBundles);
      const stages = {};
      for (const target of targets) {
        stages[target] = await stageTargetBinaryBundle(work, {
          moduleId: "teamhub",
          srcRoot: teamhubFaultyDir,
          target,
          version: ver,
          stepId: def.id,
          faulty: true,
        });
      }
      next.teamhub = await packPerTarget("teamhub", stages, ver);
      await writeStep(def, next);
    }

    // Write manifest-index.json
    const indexPayload = {
      schema: 1,
      generatedAt: new Date().toISOString(),
      baseVersion,
      channel,
      baseUrl,
      targets,
      signedWith,
      macosSigned,
      windowsSigned,
      steps: stepSummaries,
    };
    await writeFile(
      path.join(absOut, "manifest-index.json"),
      `${JSON.stringify(indexPayload, null, 2)}\n`,
      "utf8",
    );

    // Bundle zero-dependency test feed server + guide
    const feedScriptDest = path.join(absOut, "serve-test-feed.mjs");
    await cp(path.join(scriptsDir, "serve-v2-test-feed.mjs"), feedScriptDest);
    await chmod(feedScriptDest, 0o755);

    await writeFile(
      path.join(absOut, "REAL-DEVICE-TEST-GUIDE.md"),
      buildTestGuideMarkdown({
        baseVersion,
        versions,
        baseUrl,
        targets,
        macosSigned,
        windowsSigned,
        signedWith,
      }),
      "utf8",
    );

    // Deduplicate & sort SHA256SUMS.txt
    const uniqueChecksums = [...new Map(checksumFiles.map((c) => [c.rel, c.sha256])).entries()].sort(
      ([a], [b]) => a.localeCompare(b),
    );
    await writeFile(
      path.join(absOut, "SHA256SUMS.txt"),
      `${uniqueChecksums.map(([rel, sha]) => `${sha}  ${rel}`).join("\n")}\n`,
      "utf8",
    );

    // Run strict self-verification on every generated step!
    const verification = await verifyV2TestUpgradeKit(absOut, {
      publicKeyPem: verifyPublicKeyPem,
      requireSignatures: Boolean(signingPrivateKeyPem),
    });

    return {
      outDir: absOut,
      index: indexPayload,
      verification,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Verifies every generated step in a V2 test upgrade kit:
 *  - Ed25519 signature over raw app-manifest.json bytes
 *  - Every referenced .tar.zst exists and matches its sha256 + byte size
 *  - Every incremental step (step-01..step-07) changes EXACTLY its 1 target bundle
 *    and bit-for-bit inherits all 6 unchanged bundles from the preceding step.
 */
export async function verifyV2TestUpgradeKit(
  kitDir,
  { publicKeyPem = null, requireSignatures = true } = {},
) {
  const index = JSON.parse(await readFile(path.join(kitDir, "manifest-index.json"), "utf8"));
  const pubKey = publicKeyPem ? createPublicKey(publicKeyPem) : null;

  let prevManifest = null;
  const checkedSteps = [];

  for (const step of index.steps) {
    const manifestPath = path.join(kitDir, "steps", step.id, "app-manifest.json");
    const sigPath = path.join(kitDir, "steps", step.id, "app-manifest.json.sig");
    const bytes = await readFile(manifestPath);

    if (requireSignatures || existsSync(sigPath)) {
      if (!existsSync(sigPath)) {
        throw new Error(`Missing signature file for ${step.id}`);
      }
      if (!pubKey) {
        throw new Error(`Signature present for ${step.id} but no publicKeyPem supplied`);
      }
      const sigB64 = (await readFile(sigPath, "utf8")).trim();
      const valid = verify(null, bytes, pubKey, Buffer.from(sigB64, "base64"));
      if (!valid) {
        throw new Error(`Ed25519 signature verification failed for ${step.id}`);
      }
    }

    const manifest = JSON.parse(bytes.toString("utf8"));
    if (manifest.schema !== 3) {
      throw new Error(`${step.id}: expected schema 3, got ${manifest.schema}`);
    }

    // Verify all referenced archives exist & match sha256 + size
    for (const bundleId of BUNDLE_IDS) {
      const entry = manifest.bundles[bundleId];
      if (!entry) throw new Error(`${step.id}: missing bundle ${bundleId}`);
      const refs =
        entry.arch === "noarch" ? [entry.artifact] : Object.values(entry.targets);
      for (const ref of refs) {
        const relPath = ref.url.startsWith("bundles/")
          ? ref.url
          : `bundles/${bundleId}/${path.basename(new URL(ref.url).pathname)}`;
        const absFile = path.join(kitDir, relPath);
        if (!existsSync(absFile)) {
          throw new Error(`${step.id}: missing archive ${relPath}`);
        }
        const actualSize = (await stat(absFile)).size;
        const actualSha = await sha256File(absFile);
        if (actualSize !== ref.size || actualSha !== ref.sha256) {
          throw new Error(`${step.id}: checksum/size mismatch for ${relPath}`);
        }
      }
    }

    // Verify exact 1-module delta inheritance against previous step
    if (prevManifest) {
      const actualChanged = [];
      for (const bundleId of BUNDLE_IDS) {
        const prevJson = JSON.stringify(prevManifest.bundles[bundleId]);
        const nextJson = JSON.stringify(manifest.bundles[bundleId]);
        if (prevJson !== nextJson) {
          actualChanged.push(bundleId);
        }
      }
      const expected = [...step.changedModules].sort();
      const got = [...actualChanged].sort();
      if (JSON.stringify(expected) !== JSON.stringify(got)) {
        throw new Error(
          `${step.id}: expected changed modules [${expected.join(",")}] but got [${got.join(",")}]`,
        );
      }
    }

    checkedSteps.push({
      id: step.id,
      appVersion: manifest.appVersion,
      changedModules: step.changedModules,
      rollbackSafe: manifest.compat.rollbackSafe,
      signatureVerified: Boolean(pubKey && existsSync(sigPath)),
    });
    prevManifest = manifest;
  }

  return { ok: true, stepCount: checkedSteps.length, steps: checkedSteps };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const repoRoot = path.resolve(flag("--repo") ?? defaultRepoRoot);
  const outDir = path.resolve(
    flag("--out") ?? path.join(repoRoot, ".linger-runtime/v2-test-service-upgrade-packs"),
  );
  const baseVersion = flag("--base-version") ?? "0.1.10-v2test.0";
  const channel = flag("--channel") ?? "stable";
  const baseUrl = flag("--base-url") || "relative";
  const targets = (flag("--targets") ?? PLATFORM_TARGETS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const signKeyPath = flag("--sign-key");
  const ephemeralTestKey = args.includes("--ephemeral-test-key");
  const skipPubkeyCheck = args.includes("--skip-pubkey-check") || ephemeralTestKey;

  const privateKeyPem = signKeyPath
    ? await readFile(path.resolve(signKeyPath), "utf8")
    : null;

  let expectedPublicKeyPem = null;
  if (privateKeyPem && !skipPubkeyCheck) {
    const src = await readFile(path.join(desktopDir, "src/main/update-manifest.ts"), "utf8");
    expectedPublicKeyPem =
      /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/.exec(src)?.[0] ?? null;
    if (!expectedPublicKeyPem) {
      throw new Error("Could not locate UPDATE_PUBLIC_KEY in apps/desktop/src/main/update-manifest.ts");
    }
  }

  const result = await buildV2TestUpgradePacks({
    repoRoot,
    outDir,
    baseVersion,
    channel,
    baseUrl,
    targets,
    privateKeyPem,
    expectedPublicKeyPem,
    ephemeralTestKey,
    webDistDir: flag("--web-dist") ? path.resolve(flag("--web-dist")) : null,
    installerDistDir: flag("--installer-dist") ? path.resolve(flag("--installer-dist")) : null,
    nodeServicesDir: flag("--node-services-dir") ? path.resolve(flag("--node-services-dir")) : null,
    nodeNativeDepsDir: flag("--node-native-deps-dir")
      ? path.resolve(flag("--node-native-deps-dir"))
      : null,
    teamhubDir: flag("--teamhub-dir") ? path.resolve(flag("--teamhub-dir")) : null,
    teamhubV2Dir: flag("--teamhub-v2-dir") ? path.resolve(flag("--teamhub-v2-dir")) : null,
    teamhubFaultyDir: flag("--teamhub-faulty-dir")
      ? path.resolve(flag("--teamhub-faulty-dir"))
      : null,
    daemonDir: flag("--daemon-dir") ? path.resolve(flag("--daemon-dir")) : null,
    daemonV2Dir: flag("--daemon-v2-dir") ? path.resolve(flag("--daemon-v2-dir")) : null,
    teamhubCliDir: flag("--teamhub-cli-dir") ? path.resolve(flag("--teamhub-cli-dir")) : null,
    macosSigned: flag("--macos-signed") === "true",
    windowsSigned: flag("--windows-signed") === "true",
    minShellVersion: flag("--min-shell") ?? null,
  });

  process.stdout.write(`${JSON.stringify(result.verification, null, 2)}\n`);
}

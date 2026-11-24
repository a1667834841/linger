import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BUNDLE_IDS,
  computeBundleInputHash,
  computeNativeDepsHash,
  planBundleBuilds,
} from "../../scripts/compute-bundle-inputs.mjs";
import {
  assembleManifestV3,
  packDeterministicTarZst,
  signManifestV3,
} from "../../scripts/build-app-bundles.mjs";
import { verifyAppManifestV3 } from "./update-manifest.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const SAMPLE_LOCKFILE = `lockfileVersion: '9.0'
packages:
  '@livekit/rtc-node@0.13.34':
    resolution: {integrity: sha512-livekitRtcHash==}
  'better-sqlite3@11.0.0':
    resolution: {integrity: sha512-sqliteHash==}
  'sharp@0.34.1':
    resolution: {integrity: sha512-sharpHash==}
  'hono@4.12.31':
    resolution: {integrity: sha512-honoPureJsHash==}
`;

async function createMiniRepo(): Promise<string> {
  const root = await makeTempDir("linger-mini-repo-");
  const files: Record<string, string> = {
    ".node-version": "26.6.0\n",
    "pnpm-lock.yaml": SAMPLE_LOCKFILE,
    "apps/web/src/App.tsx": "export const App = () => 'v1';\n",
    "apps/node-services/src/main.ts": "export const run = () => 'v1';\n",
    "apps/node-services/prompts/memory/system.md": "# Prompt v1\n",
    "apps/teamhub/cmd/teamhub/main.go": "package main\nfunc main() {}\n",
    "apps/computer/local-daemon/cmd/main.go": "package main\nfunc main() {}\n",
    "apps/linger-installer/src/main.ts": "export const install = () => {};\n",
    "packages/service-kit/src/index.ts": "export const kit = 1;\n",
    "skills/builtin/catalog.yaml": "skills: []\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

describe("V2 bundle versioning & inputHash planner", () => {
  it("keeps nativeDepsHash stable when pure JS deps change, and bumps when native dep changes", () => {
    const base = computeNativeDepsHash(SAMPLE_LOCKFILE, {
      target: "darwin-arm64",
      nodeMajor: "26",
    });
    expect(base.packageCount).toBe(3); // @livekit/rtc-node, better-sqlite3, sharp (not hono)

    const pureJsEdited = SAMPLE_LOCKFILE.replace("honoPureJsHash==", "honoPureJsHashV2==");
    const afterJsEdit = computeNativeDepsHash(pureJsEdited, {
      target: "darwin-arm64",
      nodeMajor: "26",
    });
    expect(afterJsEdit.hash).toBe(base.hash);

    const nativeEdited = SAMPLE_LOCKFILE.replace("sharpHash==", "sharpHashV2==");
    const afterNativeEdit = computeNativeDepsHash(nativeEdited, {
      target: "darwin-arm64",
      nodeMajor: "26",
    });
    expect(afterNativeEdit.hash).not.toBe(base.hash);
  });

  it("reuses unchanged bundles and rebuilds only affected modules on web-only or shared-package edits", async () => {
    const repo = await createMiniRepo();
    const initialPlan = planBundleBuilds(repo, { useFs: true });
    expect(initialPlan.toBuild).toEqual([...BUNDLE_IDS]);

    // Build a synthetic previous Schema 3 manifest from the initial plan.
    const fakeBuilt: Record<string, unknown> = {};
    for (const id of BUNDLE_IDS) {
      const entry = initialPlan.bundles[id]!;
      const art = {
        fileName: `${id}-111111111111.tar.zst`,
        artifactId: `${id}-111111111111`,
        sha256: "a".repeat(64),
        size: 1024,
      };
      fakeBuilt[id] =
        entry.arch === "noarch"
          ? art
          : { "darwin-arm64": art, "win32-x64": art, "linux-x64": art };
    }
    const prevManifest = assembleManifestV3({
      appVersion: "0.2.14",
      plan: initialPlan,
      builtArtifacts: fakeBuilt,
      baseUrl: "https://cdn.example.com/linger",
    });

    // 1. Edit ONLY apps/web/src/App.tsx -> only `web` should rebuild!
    await writeFile(
      path.join(repo, "apps/web/src/App.tsx"),
      "export const App = () => 'v2';\n",
    );
    const webOnlyPlan = planBundleBuilds(repo, {
      useFs: true,
      prevManifest,
    });
    expect(webOnlyPlan.toBuild).toEqual(["web"]);
    expect(webOnlyPlan.reused).toContain("node-services");
    expect(webOnlyPlan.reused).toContain("node-native-deps");
    expect(webOnlyPlan.reused).toContain("teamhub");
    expect(webOnlyPlan.reused).toContain("computer-daemon");
    expect(webOnlyPlan.reused).toContain("skills-prompts");

    // 2. Edit ONLY packages/service-kit -> triggers web, node-services, computer-daemon, installer, NOT node-native-deps or teamhub!
    const baselineKitHash = computeBundleInputHash(repo, "node-native-deps", {
      useFs: true,
    }).inputHash;
    await writeFile(
      path.join(repo, "packages/service-kit/src/index.ts"),
      "export const kit = 2;\n",
    );
    const kitPlan = planBundleBuilds(repo, { useFs: true, prevManifest });
    expect(kitPlan.toBuild).toEqual(
      expect.arrayContaining([
        "web",
        "node-services",
        "computer-daemon",
        "installer",
      ]),
    );
    expect(kitPlan.reused).toContain("node-native-deps");
    expect(kitPlan.reused).toContain("teamhub");
    expect(kitPlan.reused).toContain("skills-prompts");
    expect(
      computeBundleInputHash(repo, "node-native-deps", { useFs: true }).inputHash,
    ).toBe(baselineKitHash);
  });

  it("packs deterministic .tar.zst bundles and assembles + Ed25519-signs Schema 3 manifest with inherited URLs", async () => {
    const repo = await createMiniRepo();
    const outDir = await makeTempDir("linger-pack-out-");
    const packed = await packDeterministicTarZst(
      path.join(repo, "apps/web"),
      outDir,
      "web",
    );
    expect(packed.artifactId).toMatch(/^web-[0-9a-f]{12}$/);
    expect(packed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(packed.size).toBeGreaterThan(0);

    const plan = planBundleBuilds(repo, { useFs: true });
    const builtArtifacts: Record<string, unknown> = {};
    for (const id of BUNDLE_IDS) {
      const entry = plan.bundles[id]!;
      const art = id === "web" ? packed : { ...packed, artifactId: `${id}-${packed.sha256.slice(0, 12)}` };
      builtArtifacts[id] =
        entry.arch === "noarch"
          ? art
          : { "darwin-arm64": art, "win32-x64": art, "linux-x64": art };
    }
    const manifest = assembleManifestV3({
      appVersion: "0.2.15",
      channel: "stable",
      rollout: { percent: 25 },
      plan,
      builtArtifacts,
      baseUrl: "https://cdn.example.com/linger",
      mirrorBaseUrls: ["https://mirror.example.com/linger"],
    });

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const { bytes, signatureBase64 } = signManifestV3(manifest, privPem, pubPem);
    const verified = verifyAppManifestV3(bytes, signatureBase64, pubPem);
    expect(verified.appVersion).toBe("0.2.15");
    expect(verified.rollout.percent).toBe(25);
    expect(verified.bundles.web.artifact.mirrors).toEqual([
      `https://mirror.example.com/linger/bundles/web/${packed.fileName}`,
    ]);
  });
});

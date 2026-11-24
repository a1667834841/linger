import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { LocalReleaseDescriptor } from "@linger/local-installation/release-descriptor";
import { packDeterministicTarZst } from "../../scripts/build-app-bundles.mjs";
import { BundleStoreModule } from "./bundle-store.js";
import { ConfigStore } from "./config.js";
import { EventBus, ModuleHost } from "./modules.js";

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

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function startStore(home: string, seedDirectory?: string) {
  const store = new BundleStoreModule({ home, seedDirectory, target: "darwin-arm64" });
  const config = new ConfigStore(path.join(home, "desktop-config.json"));
  const host = new ModuleHost(
    [
      { name: "Config", dependsOn: [], start: async () => {}, stop: async () => {} },
      store,
    ],
    { config, log: noopLog, bus: new EventBus() },
  );
  await host.start();
  return { store, host };
}

function makeDescriptor(
  appVersion: string,
  artifactSuffix: string,
  nodeDepsId = "nd-aaaaaaaaaaaaaaaa",
): LocalReleaseDescriptor {
  const mk = (mod: string) => ({
    artifactId: `${mod}-${artifactSuffix}`,
    originAppVersion: appVersion,
    sha256: artifactSuffix.padEnd(64, "0").slice(0, 64),
    path: `store/${mod}/${mod}-${artifactSuffix}`,
  });
  return {
    schema: 1,
    appVersion,
    channel: "stable",
    installedAt: new Date().toISOString(),
    source: "incremental-update",
    compat: {
      minShellVersion: "0.2.0",
      minNativeDepsHash: `sha256:${"a".repeat(64)}`,
      runnerGatewayProtocol: 1,
      dbSchemaEpoch: 892,
      rollbackSafe: true,
    },
    infra: {
      node: "infra/node/v26",
      postgres: "infra/postgres/pg17",
      voiceTools: "infra/voice-tools/lk1",
      nodeDeps: `infra/node-deps/${nodeDepsId}`,
    },
    modules: {
      web: mk("web"),
      "node-services": mk("node-services"),
      teamhub: mk("teamhub"),
      "computer-daemon": mk("computer-daemon"),
      installer: mk("installer"),
      "skills-prompts": mk("skills-prompts"),
    },
  };
}

describe("BundleStoreModule", () => {
  it("stages .tar.zst archives with SHA-256 verification and supports atomic pointer promotion + rollback", async () => {
    const home = await makeTempDir("linger-store-home-");
    const src = await makeTempDir("linger-store-src-");
    const out = await makeTempDir("linger-store-out-");

    await writeFile(path.join(src, "index.html"), "<h1>Linger V2</h1>", "utf8");
    const packed = await packDeterministicTarZst(src, out, "web");

    const { store } = await startStore(home);
    const extracted = await store.stageModuleArchive(
      "web",
      packed.artifactId,
      packed.filePath,
      packed.sha256,
    );
    expect(await readFile(path.join(extracted, "index.html"), "utf8")).toBe(
      "<h1>Linger V2</h1>",
    );
    expect(
      await store.hasVerifiedModule("web", packed.artifactId, packed.sha256),
    ).toBe(true);

    // Rejects wrong sha256
    await expect(
      store.stageModuleArchive("web", "web-bad", packed.filePath, "f".repeat(64)),
    ).rejects.toThrow("digest mismatch");

    // Promote 0.2.14 -> 0.2.15 -> rollback to 0.2.14 + denylist 0.2.15
    await store.writeReleaseDescriptor(makeDescriptor("0.2.14", "111111111111"));
    await store.beginPending({
      appVersion: "0.2.14",
      releaseFile: "releases/0.2.14/release.json",
      updatedAt: new Date().toISOString(),
    });
    await store.commitPending();
    expect((await store.readCurrent())?.appVersion).toBe("0.2.14");

    await store.writeReleaseDescriptor(makeDescriptor("0.2.15", "222222222222"));
    await store.beginPending({
      appVersion: "0.2.15",
      releaseFile: "releases/0.2.15/release.json",
      updatedAt: new Date().toISOString(),
    });
    await store.commitPending();
    expect((await store.readCurrent())?.appVersion).toBe("0.2.15");
    expect((await store.readPrevious())?.appVersion).toBe("0.2.14");

    const restored = await store.rollbackToPrevious(
      "0.2.15",
      "crash-watchdog",
      "crashed twice",
    );
    expect(restored?.appVersion).toBe("0.2.14");
    expect((await store.readCurrent())?.appVersion).toBe("0.2.14");
    expect(await store.isDenylisted("0.2.15")).toBe(true);
  });

  it("imports offline seed on cold start and prunes unreferenced old modules in GC while protecting current + previous", async () => {
    const home = await makeTempDir("linger-seed-home-");
    const seedDir = await makeTempDir("linger-seed-dir-");
    const payloadDir = await makeTempDir("linger-seed-payload-");
    await writeFile(path.join(payloadDir, "hello.txt"), "seed-ok", "utf8");

    const bundleNames = [
      "web",
      "node-services",
      "node-native-deps",
      "teamhub",
      "computer-daemon",
      "installer",
      "skills-prompts",
    ] as const;
    const bundles: Record<string, unknown> = {};
    for (const name of bundleNames) {
      const packed = await packDeterministicTarZst(payloadDir, seedDir, name);
      bundles[name] = {
        artifactId: packed.artifactId,
        file: packed.fileName,
        sha256: packed.sha256,
        bytes: packed.size,
      };
    }
    await writeFile(
      path.join(seedDir, "seed-manifest.json"),
      JSON.stringify({
        schema: 1,
        appVersion: "0.2.0",
        channel: "stable",
        target: "darwin-arm64",
        compat: {
          minShellVersion: "0.2.0",
          minNativeDepsHash: `sha256:${"a".repeat(64)}`,
          runnerGatewayProtocol: 1,
          dbSchemaEpoch: 892,
          rollbackSafe: true,
        },
        infra: {
          node: "infra/node/v26",
          postgres: "infra/postgres/pg17",
          voiceTools: "infra/voice-tools/lk1",
          nodeDeps: "infra/node-deps/nd-aaaaaaaaaaaaaaaa",
        },
        bundles,
      }),
    );

    const { store } = await startStore(home, seedDir);
    expect((await store.readCurrent())?.appVersion).toBe("0.2.0");
    expect(existsSync(path.join(home, "infra/node-deps/nd-aaaaaaaaaaaaaaaa/verified.json"))).toBe(true);

    // Create an unreferenced old release + old store module + old node-deps
    const staleRelDir = path.join(home, "releases/0.1.9");
    const staleModDir = path.join(home, "store/web/web-deadbeef0000");
    const staleDepsDir = path.join(home, "infra/node-deps/nd-deadbeef00000000");
    await mkdir(staleRelDir, { recursive: true });
    await mkdir(staleModDir, { recursive: true });
    await mkdir(staleDepsDir, { recursive: true });
    const oldTime = new Date(Date.now() - 48 * 60 * 60_000);
    await utimes(staleRelDir, oldTime, oldTime);
    await utimes(staleModDir, oldTime, oldTime);
    await utimes(staleDepsDir, oldTime, oldTime);

    const gc = await store.gc();
    expect(gc.removedReleases).toContain("0.1.9");
    expect(gc.removedModules).toContain("web/web-deadbeef0000");
    expect(gc.removedNodeDeps).toContain("nd-deadbeef00000000");
    // Current release 0.2.0 remains intact!
    expect(existsSync(path.join(home, "releases/0.2.0/release.json"))).toBe(true);
  });
});

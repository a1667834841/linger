import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildV2TestUpgradePacks,
  deriveStepVersions,
  verifyV2TestUpgradeKit,
} from "../../scripts/build-v2-test-upgrade-packs.mjs";
import { createTestFeedServer } from "../../scripts/serve-v2-test-feed.mjs";
import { BundleStoreModule } from "./bundle-store.js";
import { BundleUpdaterModule } from "./bundle-updater.js";
import { ConfigStore } from "./config.js";
import { EventBus, ModuleHost } from "./modules.js";
import {
  compareVersions,
  evaluateShellCompatibility,
  resolveArtifactUrl,
  type AppManifestV3,
} from "./update-manifest.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env.LINGER_UPDATE_FEED_URL;
  delete process.env.LINGER_UPDATE_CHANNEL;
  delete process.env.LINGER_ALLOW_LOOPBACK_TEST_FEED;
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

describe("V2 signed test upgrade packs & portable feed server", () => {
  it("derives deterministic SemVer-monotonic step versions within 0.1.10-v2test.0..7 and -test.0..7", () => {
    const v2test = deriveStepVersions("0.1.10-v2test.0");
    expect(v2test["step-00-baseline"]).toBe("0.1.10-v2test.0");
    expect(v2test["step-01-web"]).toBe("0.1.10-v2test.1");
    expect(v2test["step-02-skills-prompts"]).toBe("0.1.10-v2test.2");
    expect(v2test["step-03-node-services"]).toBe("0.1.10-v2test.3");
    expect(v2test["step-04-teamhub"]).toBe("0.1.10-v2test.4");
    expect(v2test["step-05-computer-daemon"]).toBe("0.1.10-v2test.5");
    expect(v2test["step-06-installer"]).toBe("0.1.10-v2test.6");
    expect(v2test["step-07-rollback-faulty"]).toBe("0.1.10-v2test.7");

    const ordered = Object.values(v2test);
    for (let i = 1; i < ordered.length; i += 1) {
      expect(compareVersions(ordered[i]!, ordered[i - 1]!)).toBeGreaterThan(0);
    }

    const legacyTest = deriveStepVersions("0.1.10-test.0");
    expect(legacyTest["step-00-baseline"]).toBe("0.1.10-test.0");
    expect(legacyTest["step-07-rollback-faulty"]).toBe("0.1.10-test.7");
  });

  it("resolves portable relative bundle paths against any feed URL while keeping https URLs intact", () => {
    expect(
      resolveArtifactUrl(
        "http://127.0.0.1:8787",
        "bundles/web/web-1234567890ab.tar.zst",
      ).toString(),
    ).toBe("http://127.0.0.1:8787/bundles/web/web-1234567890ab.tar.zst");
    expect(
      resolveArtifactUrl(
        "https://192.168.1.50:8443/feed/",
        "bundles/teamhub/teamhub-darwin-arm64-abcdef123456.tar.zst",
      ).toString(),
    ).toBe(
      "https://192.168.1.50:8443/feed/bundles/teamhub/teamhub-darwin-arm64-abcdef123456.tar.zst",
    );
    expect(
      resolveArtifactUrl(
        "http://127.0.0.1:8787",
        "https://cdn.example.com/bundles/web/web-1234567890ab.tar.zst",
      ).toString(),
    ).toBe("https://cdn.example.com/bundles/web/web-1234567890ab.tar.zst");
  });

  it("builds all 8 signed steps, verifies exact 1-module diffs, and serves incremental updates over live HTTP feed", async () => {
    const kitDir = await makeTempDir("linger-v2-kit-");
    const home = await makeTempDir("linger-v2-home-");
    const tinyWeb = await makeTempDir("linger-v2-web-");
    const tinyInstaller = await makeTempDir("linger-v2-inst-");
    await writeFile(
      path.join(tinyWeb, "index.html"),
      "<!doctype html><html><body>Linger Base Web</body></html>",
      "utf8",
    );
    await writeFile(
      path.join(tinyInstaller, "index.mjs"),
      "export const v = 'base';\n",
      "utf8",
    );

    const built = await buildV2TestUpgradePacks({
      outDir: kitDir,
      baseVersion: "0.1.10-v2test.0",
      baseUrl: "relative",
      ephemeralTestKey: true,
      macosSigned: true,
      windowsSigned: true,
      webDistDir: tinyWeb,
      installerDistDir: tinyInstaller,
    });

    expect(built.verification.ok).toBe(true);
    expect(built.verification.stepCount).toBe(8);
    expect(built.verification.steps.every((s) => s.signatureVerified)).toBe(true);

    // Every step's minShellVersion MUST be satisfied by the 0.1.10-v2test.0 test shell!
    for (const step of built.index.steps) {
      const manifest = JSON.parse(
        await readFile(path.join(kitDir, "steps", step.id, "app-manifest.json"), "utf8"),
      ) as AppManifestV3;
      expect(manifest.compat.minShellVersion).toBe("0.1.10-v2test.0");
      expect(evaluateShellCompatibility(manifest, "0.1.10-v2test.0")).toEqual({
        status: "compatible",
      });
    }

    const publicKeyPem = await readFile(
      path.join(kitDir, "test-public-key.pem"),
      "utf8",
    );
    const reVerified = await verifyV2TestUpgradeKit(kitDir, {
      publicKeyPem,
      requireSignatures: true,
    });
    expect(reVerified.ok).toBe(true);

    const server = await createTestFeedServer({
      rootDir: kitDir,
      initialStep: "00",
      host: "127.0.0.1",
      port: 0,
      quiet: true,
    });

    try {
      const store = new BundleStoreModule({ home, target: "darwin-arm64" });
      const config = new ConfigStore(path.join(home, "config.json"), {
        installId: "real-device-test-install",
      });
      const bus = new EventBus();
      const updater = new BundleUpdaterModule({
        shellVersion: "0.1.10-v2test.0",
        target: "darwin-arm64",
        enabled: true,
        checkDelayMs: 60 * 60_000,
        publicKey: publicKeyPem,
      });

      const host = new ModuleHost(
        [
          { name: "Config", dependsOn: [], start: async () => {}, stop: async () => {} },
          store,
          updater,
        ],
        { config, log: noopLog, bus },
      );
      await host.start();

      // 1. Without LINGER_ALLOW_LOOPBACK_TEST_FEED=1, http://127.0.0.1 MUST be refused!
      process.env.LINGER_UPDATE_FEED_URL = server.feedUrl;
      await updater.check();
      expect(updater.state().kind).toBe("failed");

      // 2. Enable loopback test feed flag -> step-00-baseline downloads all 7 modules
      process.env.LINGER_ALLOW_LOOPBACK_TEST_FEED = "1";
      await updater.check();
      expect(updater.state()).toEqual({
        kind: "staged",
        version: "0.1.10-v2test.0",
        changedModules: [
          "node-native-deps",
          "web",
          "node-services",
          "teamhub",
          "computer-daemon",
          "installer",
          "skills-prompts",
        ],
      });
      // Commit step-00 as current release
      await store.beginPending({
        appVersion: "0.1.10-v2test.0",
        releaseFile: "releases/0.1.10-v2test.0/release.json",
        updatedAt: new Date().toISOString(),
      });
      await store.commitPending();

      // 3. Switch live via HTTP API to step-01-web -> ONLY web (1/7) downloads!
      const sw1 = await fetch(`${server.feedUrl}/__test/switch?step=01`, {
        method: "POST",
      });
      expect(sw1.ok).toBe(true);
      await fetch(`${server.feedUrl}/__test/reset-log`, { method: "POST" });

      await updater.check();
      expect(updater.state()).toEqual({
        kind: "staged",
        version: "0.1.10-v2test.1",
        changedModules: ["web"],
      });
      const step1Downloads = server
        .getDownloadHistory()
        .filter((h) => h.path.startsWith("/bundles/"));
      expect(step1Downloads).toHaveLength(1);
      expect(step1Downloads[0]?.path).toMatch(/^\/bundles\/web\/web-/);

      // 4. Commit step-01..07 sequentially to verify each step downloads strictly 1/7 bundle!
      for (const [stepNum, expectedVersion, expectedMod] of [
        ["01", "0.1.10-v2test.1", "web"],
        ["02", "0.1.10-v2test.2", "skills-prompts"],
        ["03", "0.1.10-v2test.3", "node-services"],
        ["04", "0.1.10-v2test.4", "teamhub"],
        ["05", "0.1.10-v2test.5", "computer-daemon"],
        ["06", "0.1.10-v2test.6", "installer"],
        ["07", "0.1.10-v2test.7", "teamhub"],
      ] as const) {
        if (stepNum !== "01") {
          const sw = await fetch(
            `${server.feedUrl}/__test/switch?step=${stepNum}`,
            { method: "POST" },
          );
          expect(sw.ok).toBe(true);
          await fetch(`${server.feedUrl}/__test/reset-log`, { method: "POST" });
          await updater.check();
          expect(updater.state()).toEqual({
            kind: "staged",
            version: expectedVersion,
            changedModules: [expectedMod],
          });
          const dl = server
            .getDownloadHistory()
            .filter((h) => h.path.startsWith("/bundles/"));
          expect(dl).toHaveLength(1);
          expect(dl[0]?.path).toContain(`/bundles/${expectedMod}/`);
        }
        await store.beginPending({
          appVersion: expectedVersion,
          releaseFile: `releases/${expectedVersion}/release.json`,
          updatedAt: new Date().toISOString(),
        });
        await store.commitPending();
      }

      // Confirm step-07 descriptor carries rollbackSafe: false
      const step7Desc = await store.readRelease("0.1.10-v2test.7");
      expect(step7Desc?.compat.rollbackSafe).toBe(false);

      await host.stop("quit");
    } finally {
      await server.close();
    }
  }, 30_000);
});

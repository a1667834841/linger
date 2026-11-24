import type {
  BundleModuleId,
  LocalReleaseDescriptor,
} from "@linger/local-installation/release-descriptor";

import type { UpdateActionKind, UpdateScope } from "../shared/api.js";
import type { BundleStoreModule } from "./bundle-store.js";
import type { HealthProbe, HealthWatchdogModule } from "./health-watchdog.js";
import type { Module, ModuleContext } from "./modules.js";

export interface ReleaseDiff {
  readonly changedModules: readonly BundleModuleId[];
  readonly nodeDepsChanged: boolean;
  readonly scope: UpdateScope;
  readonly action: UpdateActionKind;
  readonly requiresDrain: boolean;
}

export interface RollbackNotice {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly reason: string;
}

export interface ReleaseOrchestratorHooks {
  readonly activeOperations: () => number;
  readonly isVoiceIdle?: () => Promise<boolean>;
  readonly hotReloadSkills?: (release: LocalReleaseDescriptor) => Promise<void>;
  readonly hotReloadWeb?: (release: LocalReleaseDescriptor) => Promise<void>;
  readonly backupDatabase?: (appVersion: string) => Promise<string>;
  readonly restoreDatabase?: (backupFile: string) => Promise<void>;
  readonly restartServices: (
    release: LocalReleaseDescriptor,
    changed: readonly BundleModuleId[],
  ) => Promise<void>;
  readonly buildHealthProbes: (
    release: LocalReleaseDescriptor,
    changed: readonly BundleModuleId[],
  ) => readonly HealthProbe[];
  readonly healthGateTimeoutMs?: number;
  readonly healthGateIntervalMs?: number;
  readonly observationWindowMs?: number;
  readonly observationMaxCrashes?: number;
}

export type OrchestratorState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "ready";
      readonly version: string;
      readonly diff: ReleaseDiff;
    }
  | {
      readonly kind: "waiting";
      readonly version: string;
      readonly diff: ReleaseDiff;
    }
  | {
      readonly kind: "applying";
      readonly version: string;
      readonly diff: ReleaseDiff;
    }
  | {
      readonly kind: "rolled_back";
      readonly notice: RollbackNotice;
    };

const ALL_MODULES: readonly BundleModuleId[] = [
  "web",
  "node-services",
  "teamhub",
  "computer-daemon",
  "installer",
  "skills-prompts",
];

/**
 * Computes the minimal set of changed modules between two release descriptors
 * and derives the smallest disruption update scope (0-downtime skills/web hot
 * reload vs tiered backend service restart).
 */
export function diffReleaseModules(
  current: LocalReleaseDescriptor | undefined,
  next: LocalReleaseDescriptor,
): ReleaseDiff {
  const changed: BundleModuleId[] = [];
  for (const mod of ALL_MODULES) {
    if (!current || current.modules[mod].sha256 !== next.modules[mod].sha256) {
      changed.push(mod);
    }
  }
  const nodeDepsChanged =
    !current || current.infra.nodeDeps !== next.infra.nodeDeps;

  const onlySkills =
    !nodeDepsChanged &&
    changed.length > 0 &&
    changed.every((m) => m === "skills-prompts");
  const onlyWebOrSkills =
    !nodeDepsChanged &&
    changed.length > 0 &&
    changed.every((m) => m === "web" || m === "skills-prompts");

  if (onlySkills) {
    return {
      changedModules: changed,
      nodeDepsChanged,
      scope: "skills",
      action: "reload-page",
      requiresDrain: false,
    };
  }
  if (onlyWebOrSkills) {
    return {
      changedModules: changed,
      nodeDepsChanged,
      scope: "web",
      action: "reload-page",
      requiresDrain: false,
    };
  }
  return {
    changedModules: changed,
    nodeDepsChanged,
    scope: "app",
    action: "restart-services",
    requiresDrain: true,
  };
}

/**
 * Coordinates safe V2 bundle transitions:
 *   - Drains active ComputerDaemon tasks & voice recordings before backend restarts
 *   - Applies 0-downtime hot swaps for `skills-prompts` and `web`
 *   - Protects non-rollbackSafe DB migrations with pre-migration `pg_dump`
 *   - Enforces HealthWatchdog 60s probe gate + 2-min crash rollback & denylist
 */
export class ReleaseOrchestratorModule implements Module {
  readonly name = "ReleaseOrchestrator";
  readonly dependsOn = ["Config", "BundleStore", "HealthWatchdog"];
  readonly #hooks: ReleaseOrchestratorHooks;
  #ctx: ModuleContext | undefined;
  #state: OrchestratorState = { kind: "idle" };
  #stagedVersion: string | undefined;
  #rollbackNotice: RollbackNotice | undefined;
  readonly #unsubscribe: (() => void)[] = [];

  constructor(hooks: ReleaseOrchestratorHooks) {
    this.#hooks = hooks;
  }

  state(): OrchestratorState {
    return this.#state;
  }

  rollbackNotice(): RollbackNotice | undefined {
    return this.#rollbackNotice;
  }

  dismissRollbackNotice(): void {
    this.#rollbackNotice = undefined;
    if (this.#state.kind === "rolled_back") {
      this.#setState({ kind: "idle" });
    }
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    this.#unsubscribe.push(
      ctx.bus.on("bundle.staged", (appVersion) => {
        void this.onBundleStaged(appVersion);
      }),
      ctx.bus.on("runtime.activity", (running) => {
        if (running === 0 && this.#state.kind === "waiting") {
          void this.applyStaged();
        }
      }),
    );
  }

  async stop(): Promise<void> {
    for (const off of this.#unsubscribe.splice(0)) off();
  }

  async onBundleStaged(appVersion: string): Promise<void> {
    const store = this.#ctx!.get<BundleStoreModule>("BundleStore");
    const next = await store.readRelease(appVersion);
    if (!next) return;
    const current = await store.currentRelease();
    const diff = diffReleaseModules(current, next);
    this.#stagedVersion = appVersion;

    // Zero-downtime skills-only updates apply silently immediately.
    if (diff.scope === "skills" && this.#hooks.hotReloadSkills) {
      await this.applyStaged();
      return;
    }
    this.#setState({ kind: "ready", version: appVersion, diff });
  }

  async applyStaged(): Promise<boolean> {
    const version = this.#stagedVersion;
    if (!version) return false;
    const ctx = this.#ctx!;
    const store = ctx.get<BundleStoreModule>("BundleStore");
    const watchdog = ctx.get<HealthWatchdogModule>("HealthWatchdog");
    const next = await store.readRelease(version);
    if (!next) return false;
    const current = await store.currentRelease();
    const diff = diffReleaseModules(current, next);

    if (diff.requiresDrain) {
      const busy =
        this.#hooks.activeOperations() > 0 ||
        (this.#hooks.isVoiceIdle ? !(await this.#hooks.isVoiceIdle()) : false);
      if (busy) {
        this.#setState({ kind: "waiting", version, diff });
        return false;
      }
    }

    this.#setState({ kind: "applying", version, diff });
    ctx.bus.emit("release.switching", version);

    let dbBackupFile: string | undefined;
    try {
      if (
        !next.compat.rollbackSafe &&
        diff.changedModules.includes("teamhub") &&
        this.#hooks.backupDatabase
      ) {
        dbBackupFile = await this.#hooks.backupDatabase(version);
      }

      await store.beginPending({
        appVersion: version,
        releaseFile: `releases/${version}/release.json`,
        updatedAt: new Date().toISOString(),
        ...(dbBackupFile ? { dbBackupFile } : {}),
      });

      if (diff.scope === "skills" && this.#hooks.hotReloadSkills) {
        await this.#hooks.hotReloadSkills(next);
      } else if (diff.scope === "web" && this.#hooks.hotReloadWeb) {
        if (
          diff.changedModules.includes("skills-prompts") &&
          this.#hooks.hotReloadSkills
        ) {
          await this.#hooks.hotReloadSkills(next);
        }
        await this.#hooks.hotReloadWeb(next);
        ctx.bus.emit("web.reload_ready", version);
      } else {
        await this.#hooks.restartServices(next, diff.changedModules);
      }

      const probes = this.#hooks.buildHealthProbes(next, diff.changedModules);
      const health = await watchdog.waitForHealthy(probes, {
        timeoutMs: this.#hooks.healthGateTimeoutMs,
        intervalMs: this.#hooks.healthGateIntervalMs,
      });
      if (!health.ok) {
        throw new Error(
          `Health probes failed: ${health.failedProbes.join(", ")}`,
        );
      }

      await store.commitPending();
      this.#stagedVersion = undefined;
      this.#setState({ kind: "idle" });
      ctx.log.info("release_orchestrator.committed", {
        appVersion: version,
        changedModules: diff.changedModules,
      });
      ctx.bus.emit("release.committed", version);

      // Post-commit 2-minute crash observation window for backend restarts.
      if (diff.requiresDrain && current) {
        watchdog.startObservation({
          appVersion: version,
          windowMs: this.#hooks.observationWindowMs,
          maxCrashes: this.#hooks.observationMaxCrashes,
          onRollback: async (reason) => {
            await this.#performRollback(
              version,
              current,
              diff.changedModules,
              "crash-watchdog",
              reason,
              dbBackupFile,
            );
          },
        });
      }

      // Async GC in background after a healthy commit.
      void store.gc().catch(() => undefined);
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.#performRollback(
        version,
        current,
        diff.changedModules,
        "healthcheck",
        reason,
        dbBackupFile,
      );
      return false;
    }
  }

  async #performRollback(
    failedVersion: string,
    previousRelease: LocalReleaseDescriptor | undefined,
    changedModules: readonly BundleModuleId[],
    stage: "migrate" | "healthcheck" | "crash-watchdog",
    reason: string,
    dbBackupFile?: string,
  ): Promise<void> {
    const ctx = this.#ctx!;
    const store = ctx.get<BundleStoreModule>("BundleStore");
    ctx.log.warn("release_orchestrator.rolling_back", {
      failedVersion,
      previousVersion: previousRelease?.appVersion,
      stage,
      reason,
    });
    if (dbBackupFile && this.#hooks.restoreDatabase) {
      await this.#hooks.restoreDatabase(dbBackupFile).catch((err) => {
        ctx.log.warn("release_orchestrator.db_restore_failed", {
          error: String(err),
        });
      });
    }
    const restoredPtr = await store.rollbackToPrevious(
      failedVersion,
      stage,
      reason,
    );
    if (previousRelease) {
      await this.#hooks
        .restartServices(previousRelease, changedModules)
        .catch(() => undefined);
    }
    this.#stagedVersion = undefined;
    const notice: RollbackNotice = {
      fromVersion: failedVersion,
      toVersion: restoredPtr?.appVersion ?? previousRelease?.appVersion ?? "previous",
      reason,
    };
    this.#rollbackNotice = notice;
    this.#setState({ kind: "rolled_back", notice });
    ctx.bus.emit("release.rolled_back", notice.fromVersion, notice.toVersion, notice.reason);
  }

  #setState(state: OrchestratorState): void {
    this.#state = state;
    this.#ctx?.bus.emit("update.changed", state.kind);
  }
}

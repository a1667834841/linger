import { mkdirSync } from "node:fs";
import path from "node:path";

import {
  localmodelsToolEnvironment,
  localmodelsToolFromEnvironment,
  type LocalmodelsComputerTool,
} from "@linger/local-installation/localmodels-computer";

export interface DevLocalmodelsOverride {
  readonly python: string;
  readonly moduleDirectory: string;
}

/**
 * Reads optional development overrides pointing the Desktop Computer daemon at
 * a local llm-inference-lab checkout instead of the pinned kit archive.
 */
export function readDevLocalmodelsOverride(
  env: Readonly<Record<string, string | undefined>>,
  platformPath: typeof path = path,
): DevLocalmodelsOverride | undefined {
  const python = env.LINGER_LOCALMODELS_DEV_PYTHON?.trim();
  const moduleDirectory = env.LINGER_LOCALMODELS_DEV_MODULE_DIR?.trim();
  if (!python && !moduleDirectory) return undefined;
  if (!python || !moduleDirectory)
    throw new Error(
      "LINGER_LOCALMODELS_DEV_PYTHON and LINGER_LOCALMODELS_DEV_MODULE_DIR must be set together.",
    );
  if (
    !platformPath.isAbsolute(python) ||
    !platformPath.isAbsolute(moduleDirectory)
  )
    throw new Error(
      "LINGER_LOCALMODELS_DEV_PYTHON and LINGER_LOCALMODELS_DEV_MODULE_DIR must be absolute paths.",
    );
  return { python, moduleDirectory };
}

/**
 * Applies the localmodels checkout override on top of the daemon environment,
 * preserving any existing state/base directories from a custom install home or
 * deriving them under `home` when running directly against `pnpm dev`.
 */
export function applyDevLocalmodelsEnvironment(
  env: Readonly<Record<string, string>>,
  override: DevLocalmodelsOverride | undefined,
  home: string,
  platformPath: typeof path = path,
): Record<string, string> {
  if (!override) return { ...env };
  const existing = localmodelsToolFromEnvironment(env, platformPath);
  const resolvedHome = platformPath.resolve(home);
  const tool: LocalmodelsComputerTool = {
    python: override.python,
    moduleDirectory: override.moduleDirectory,
    stateDirectory:
      existing?.stateDirectory ??
      platformPath.join(resolvedHome, "runtime", "localmodels", "state"),
    baseDirectory:
      existing?.baseDirectory ??
      platformPath.join(resolvedHome, "runtime", "localmodels", "models"),
  };
  return {
    ...env,
    ...localmodelsToolEnvironment(tool),
  };
}

/** Ensures private state and model directories exist before launching the daemon. */
export function ensureDevLocalmodelsDirectories(
  env: Readonly<Record<string, string>>,
): void {
  const tool = localmodelsToolFromEnvironment(env);
  if (!tool) return;
  mkdirSync(tool.stateDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(tool.baseDirectory, { recursive: true, mode: 0o700 });
}

// watch-smoke-touch

// live-watch-edit

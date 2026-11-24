import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { localmodelsToolFromEnvironment } from "@linger/local-installation/localmodels-computer";

import {
  applyDevLocalmodelsEnvironment,
  ensureDevLocalmodelsDirectories,
  readDevLocalmodelsOverride,
} from "./dev-localmodels.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("readDevLocalmodelsOverride", () => {
  it("returns undefined when neither override variable is set", () => {
    expect(readDevLocalmodelsOverride({})).toBeUndefined();
    expect(
      readDevLocalmodelsOverride({
        LINGER_LOCALMODELS_DEV_PYTHON: "  ",
        LINGER_LOCALMODELS_DEV_MODULE_DIR: "",
      }),
    ).toBeUndefined();
  });

  it("rejects partial or relative override paths", () => {
    expect(() =>
      readDevLocalmodelsOverride({
        LINGER_LOCALMODELS_DEV_PYTHON: "/opt/venv/bin/python",
      }),
    ).toThrow(/set together/i);
    expect(() =>
      readDevLocalmodelsOverride({
        LINGER_LOCALMODELS_DEV_MODULE_DIR: "/src/llm-inference-lab",
      }),
    ).toThrow(/set together/i);
    expect(() =>
      readDevLocalmodelsOverride({
        LINGER_LOCALMODELS_DEV_PYTHON: "python3",
        LINGER_LOCALMODELS_DEV_MODULE_DIR: "/src/llm-inference-lab",
      }),
    ).toThrow(/absolute paths/i);
  });

  it("reads absolute POSIX and Windows paths", () => {
    expect(
      readDevLocalmodelsOverride(
        {
          LINGER_LOCALMODELS_DEV_PYTHON: " /opt/venv/bin/python ",
          LINGER_LOCALMODELS_DEV_MODULE_DIR: "/src/llm-inference-lab",
        },
        path.posix,
      ),
    ).toEqual({
      python: "/opt/venv/bin/python",
      moduleDirectory: "/src/llm-inference-lab",
    });

    expect(
      readDevLocalmodelsOverride(
        {
          LINGER_LOCALMODELS_DEV_PYTHON: "C:\\lab\\.venv\\Scripts\\python.exe",
          LINGER_LOCALMODELS_DEV_MODULE_DIR: "C:\\lab",
        },
        path.win32,
      ),
    ).toEqual({
      python: "C:\\lab\\.venv\\Scripts\\python.exe",
      moduleDirectory: "C:\\lab",
    });
  });
});

describe("applyDevLocalmodelsEnvironment", () => {
  it("derives state and base directories from home when connecting without Quick Install", () => {
    const result = applyDevLocalmodelsEnvironment(
      { HOME: "/home/dev", LOCALMODELS_DEBUG: "simulate" },
      {
        python: "/src/lab/.venv/bin/python",
        moduleDirectory: "/src/lab",
      },
      "/tmp/dev-home",
      path.posix,
    );

    expect(result.LOCALMODELS_DEBUG).toBe("simulate");
    expect(localmodelsToolFromEnvironment(result, path.posix)).toEqual({
      python: "/src/lab/.venv/bin/python",
      moduleDirectory: "/src/lab",
      stateDirectory: "/tmp/dev-home/runtime/localmodels/state",
      baseDirectory: "/tmp/dev-home/runtime/localmodels/models",
    });
  });

  it("overrides python and module directory while keeping existing install state and model directories", () => {
    const result = applyDevLocalmodelsEnvironment(
      {
        LINGER_LOCALMODELS_PYTHON: "/old/kit/python",
        LINGER_LOCALMODELS_MODULE_DIR: "/old/kit/mod",
        LINGER_LOCALMODELS_STATE: "/custom/home/runtime/localmodels/state",
        LINGER_LOCALMODELS_BASE_DIR: "/custom/home/runtime/localmodels/models",
      },
      {
        python: "/src/lab/.venv/bin/python",
        moduleDirectory: "/src/lab",
      },
      "/default/home",
      path.posix,
    );

    expect(localmodelsToolFromEnvironment(result, path.posix)).toEqual({
      python: "/src/lab/.venv/bin/python",
      moduleDirectory: "/src/lab",
      stateDirectory: "/custom/home/runtime/localmodels/state",
      baseDirectory: "/custom/home/runtime/localmodels/models",
    });
  });

  it("creates state and models directories when ensuring dev directories", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dev-localmodels-"));
    roots.push(root);
    const env = applyDevLocalmodelsEnvironment(
      {},
      {
        python: path.join(root, "python"),
        moduleDirectory: root,
      },
      path.join(root, "home"),
    );
    ensureDevLocalmodelsDirectories(env);
    expect(
      existsSync(path.join(root, "home", "runtime", "localmodels", "state")),
    ).toBe(true);
    expect(
      existsSync(path.join(root, "home", "runtime", "localmodels", "models")),
    ).toBe(true);
  });
});

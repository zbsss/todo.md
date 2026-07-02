import { convertFileSrc } from "@tauri-apps/api/core";

export type AppRuntime = {
  isTauri: boolean;
  fileSrcConverter?: (path: string) => string;
};

export function detectAppRuntime(): AppRuntime {
  const isTauri = "__TAURI_INTERNALS__" in window;

  return {
    isTauri,
    fileSrcConverter: isTauri ? convertFileSrc : undefined
  };
}

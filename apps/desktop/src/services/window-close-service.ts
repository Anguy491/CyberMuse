import { getCurrentWindow } from "@tauri-apps/api/window";

export interface WindowCloseRequest {
  preventDefault(): void;
}

export interface WindowCloseServicePort {
  subscribe(
    listener: (request: WindowCloseRequest) => void,
  ): Promise<() => void>;
  destroy(): Promise<void>;
}

function hasTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

export class WindowCloseService implements WindowCloseServicePort {
  async subscribe(
    listener: (request: WindowCloseRequest) => void,
  ): Promise<() => void> {
    if (!hasTauriRuntime()) return () => undefined;
    return getCurrentWindow().onCloseRequested((event) => {
      listener({ preventDefault: () => event.preventDefault() });
    });
  }

  async destroy(): Promise<void> {
    if (!hasTauriRuntime()) return;
    await getCurrentWindow().destroy();
  }
}

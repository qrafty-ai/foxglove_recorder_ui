import { ExtensionContext } from "@foxglove/extension";

import { initRecorderPanel } from "./RecorderPanel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({ name: "recorder-panel", initPanel: initRecorderPanel });
}

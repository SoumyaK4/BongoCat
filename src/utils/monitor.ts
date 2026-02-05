import type { PhysicalPosition } from '@tauri-apps/api/window'

import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { availableMonitors, cursorPosition, monitorFromPoint } from '@tauri-apps/api/window'

export async function getCursorMonitor(cursorPoint?: PhysicalPosition) {
  cursorPoint ??= await cursorPosition()

  const appWindow = getCurrentWebviewWindow()

  const scaleFactor = await appWindow.scaleFactor()

  const { x, y } = cursorPoint.toLogical(scaleFactor)

  let monitor = await monitorFromPoint(x, y)

  if (!monitor) {
    const monitors = await availableMonitors()
    monitor = monitors[0]
  }

  if (!monitor) return

  return monitor
}

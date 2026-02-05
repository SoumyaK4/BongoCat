import { invoke } from '@tauri-apps/api/core'
import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { cursorPosition } from '@tauri-apps/api/window'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'

import { INVOKE_KEY, LISTEN_KEY } from '../constants'

import { useModel } from './useModel'
import { useTauriListen } from './useTauriListen'

import { useCatStore } from '@/stores/cat'
import { useModelStore } from '@/stores/model'
import { inBetween } from '@/utils/is'
import { isWindows } from '@/utils/platform'

interface MouseButtonEvent {
  kind: 'MousePress' | 'MouseRelease'
  value: string
}

export interface CursorPoint {
  x: number
  y: number
}

interface MouseMoveEvent {
  kind: 'MouseMove'
  value: CursorPoint
}

interface KeyboardEvent {
  kind: 'KeyboardPress' | 'KeyboardRelease'
  value: string
}

type DeviceEvent = MouseButtonEvent | MouseMoveEvent | KeyboardEvent

const virtualCursorPos = { x: 0, y: 0 }
const lastTauriPos = { x: -1, y: -1 }

export function useDevice() {
  const { t } = useI18n()
  const modelStore = useModelStore()
  const releaseTimers = new Map<string, NodeJS.Timeout>()
  const catStore = useCatStore()
  const { handlePress, handleRelease, handleMouseChange, handleMouseMove } = useModel()

  const startListening = async () => {
    const pos = await cursorPosition()
    virtualCursorPos.x = pos.x
    virtualCursorPos.y = pos.y
    lastTauriPos.x = pos.x
    lastTauriPos.y = pos.y

    try {
      await invoke(INVOKE_KEY.START_DEVICE_LISTENING)
    } catch (error) {
      message.error(t('composables.useDevice.errors.failedToAssignSeat'))
      console.error(error)
    }
  }

  const getSupportedKey = (key: string) => {
    let nextKey = key

    const unsupportedKey = !modelStore.supportKeys[nextKey]

    if (key.startsWith('F') && unsupportedKey) {
      nextKey = key.replace(/F(\d+)/, 'Fn')
    }

    for (const item of ['Meta', 'Shift', 'Alt', 'Control']) {
      if (key.startsWith(item) && unsupportedKey) {
        const regex = new RegExp(`^(${item}).*`)
        nextKey = key.replace(regex, '$1')
      }
    }

    return nextKey
  }

  const handleCursorMove = async (value: any) => {
    const tauriPos = await cursorPosition()

    const tauriMoved = tauriPos.x !== lastTauriPos.x || tauriPos.y !== lastTauriPos.y

    if (tauriMoved) {
      virtualCursorPos.x = tauriPos.x
      virtualCursorPos.y = tauriPos.y
      lastTauriPos.x = tauriPos.x
      lastTauriPos.y = tauriPos.y
    } else if (value && typeof value === 'object') {
      if ('dx' in value && 'dy' in value) {
        virtualCursorPos.x += value.dx
        virtualCursorPos.y += value.dy
      } else if ('x' in value && 'y' in value) {
        virtualCursorPos.x = value.x
        virtualCursorPos.y = value.y
      }
    }

    handleMouseMove(new PhysicalPosition(virtualCursorPos.x, virtualCursorPos.y))

    if (catStore.window.hideOnHover) {
      const appWindow = getCurrentWebviewWindow()
      const position = await appWindow.outerPosition()
      const { width, height } = await appWindow.innerSize()

      const isInWindow = inBetween(virtualCursorPos.x, position.x, position.x + width)
        && inBetween(virtualCursorPos.y, position.y, position.y + height)

      document.body.style.setProperty('opacity', isInWindow ? '0' : 'unset')

      if (!catStore.window.passThrough) {
        appWindow.setIgnoreCursorEvents(isInWindow)
      }
    }
  }

  const handleAutoRelease = (key: string, delay = 100) => {
    handlePress(key)

    if (releaseTimers.has(key)) {
      clearTimeout(releaseTimers.get(key))
    }

    const timer = setTimeout(() => {
      handleRelease(key)

      releaseTimers.delete(key)
    }, delay)

    releaseTimers.set(key, timer)
  }

  useTauriListen<DeviceEvent>(LISTEN_KEY.DEVICE_CHANGED, ({ payload }) => {
    const { kind, value } = payload

    if (kind === 'KeyboardPress' || kind === 'KeyboardRelease') {
      const nextValue = getSupportedKey(value)

      if (!nextValue) return

      if (nextValue === 'CapsLock') {
        return handleAutoRelease(nextValue)
      }

      if (kind === 'KeyboardPress') {
        if (isWindows) {
          const delay = catStore.model.autoReleaseDelay * 1000

          return handleAutoRelease(nextValue, delay)
        }

        return handlePress(nextValue)
      }

      return handleRelease(nextValue)
    }

    switch (kind) {
      case 'MousePress':
        return handleMouseChange(value)
      case 'MouseRelease':
        return handleMouseChange(value, false)
      case 'MouseMove':
        return handleCursorMove(value)
    }
  })

  return {
    startListening,
  }
}

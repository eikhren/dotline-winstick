import { BrowserWindow, ipcMain, screen } from "electron"
import type { AttachState, Geometry, WindowRef } from "@/types/windowAttach"
import { X11Provider, isX11Session } from "./x11-provider"

type Provider = {
  listWindows(): Promise<WindowRef[]>
  getActiveWindow(): Promise<number | null>
  getGeometry(windowId: number): Promise<(Geometry & { mapped: boolean }) | null>
  watchGeometry(
    windowId: number,
    opts: { intervalMs?: number; onChange: (g: Geometry & { mapped: boolean }) => void; onMissing?: () => void }
  ): () => void
}

type Options = {
  pollMs?: number
  enabled?: boolean
}

export class WindowAttachService {
  private provider: Provider | null
  private getOverlayWindow: () => BrowserWindow | null
  private state: AttachState = { mode: "detached", targetId: null, lastGeometry: null }
  private stopWatch: (() => void) | null = null
  private stopFollow: (() => void) | null = null
  private stopVisibilityWatch: (() => void) | null = null
  private pollMs: number
  private enabled: boolean
  private preAttachBounds: Electron.Rectangle | null = null
  private lastMapped = false
  private lastActive = false

  constructor(getOverlayWindow: () => BrowserWindow | null, opts?: Options) {
    this.getOverlayWindow = getOverlayWindow
    this.pollMs = Math.max(50, Math.min(500, opts?.pollMs ?? 100))
    this.enabled = opts?.enabled ?? (isX11Session() ? true : false)
    this.provider = this.enabled && isX11Session() ? new X11Provider() : null
  }

  getState(): AttachState {
    return { ...this.state }
  }

  isEnabled(): boolean {
    return this.enabled && !!this.provider
  }

  async listWindows(): Promise<WindowRef[]> {
    if (!this.isEnabled()) return []
    return this.provider!.listWindows()
  }

  private applyOverlayBounds(g: Geometry, mapped: boolean): void {
    const win = this.getOverlayWindow()
    if (!win) return
    if (!mapped) {
      if (win.isVisible()) win.hide()
      return
    }
    const b = win.getBounds()
    if (b.x !== g.x || b.y !== g.y || b.width !== g.width || b.height !== g.height) {
      win.setBounds({ x: g.x, y: g.y, width: g.width, height: g.height })
      win.setAlwaysOnTop(true, "screen-saver")
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      win.setIgnoreMouseEvents(true, { forward: true })
      if (!win.isVisible()) win.showInactive()
    } else if (!win.isVisible() && mapped) {
      win.showInactive()
    }
  }

  private stopAll(): void {
    if (this.stopWatch) {
      this.stopWatch()
      this.stopWatch = null
    }
    if (this.stopFollow) {
      this.stopFollow()
      this.stopFollow = null
    }
    if (this.stopVisibilityWatch) {
      this.stopVisibilityWatch()
      this.stopVisibilityWatch = null
    }
  }

  private restoreOverlayBounds(): void {
    const win = this.getOverlayWindow()
    if (!win) return
    if (this.preAttachBounds) {
      const b = this.preAttachBounds
      win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height })
    } else {
      const d = screen.getPrimaryDisplay().bounds
      win.setBounds({ x: d.x, y: d.y, width: d.width, height: d.height })
    }
    win.setAlwaysOnTop(true, "screen-saver")
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setIgnoreMouseEvents(true, { forward: true })
    if (!win.isVisible()) win.showInactive()
  }

  async attach(windowId: number): Promise<boolean> {
    if (!this.isEnabled()) return false
    const win = this.getOverlayWindow()
    if (!win) return false

    // Capture bounds to restore on detach
    if (this.state.mode === "detached") {
      this.preAttachBounds = win.getBounds()
    }

    this.stopAll()
    this.state = { mode: "attached", targetId: windowId, lastGeometry: null }

    this.stopWatch = this.provider!.watchGeometry(windowId, {
      intervalMs: this.pollMs,
      onChange: (g) => {
        this.state.lastGeometry = { x: g.x, y: g.y, width: g.width, height: g.height }
        this.lastMapped = g.mapped
        this.applyOverlayBounds(g, g.mapped)
        this.syncOverlayVisibility()
      },
      onMissing: () => {
        // Hide when missing/unmapped
        const ow = this.getOverlayWindow()
        this.lastMapped = false
        if (ow?.isVisible()) ow.hide()
      }
    })

    // Visibility watchdog: hide overlay if target window is not front/active
    const visTimer = setInterval(async () => {
      try {
        const active = await this.provider!.getActiveWindow()
        this.lastActive = active === windowId
        this.syncOverlayVisibility()
      } catch {}
    }, this.pollMs)
    this.stopVisibilityWatch = () => clearInterval(visTimer)

    return true
  }

  async followFocused(enable: boolean): Promise<boolean> {
    if (!this.isEnabled()) return false
    this.stopAll()
    if (!enable) {
      this.state = { mode: "detached", targetId: null, lastGeometry: null }
      this.restoreOverlayBounds()
      return true
    }
    this.state = { mode: "follow", targetId: null, lastGeometry: null }

    let lastActive: number | null = null
    const tick = async () => {
      const id = await this.provider!.getActiveWindow()
      if (!id) return
      if (id !== lastActive) {
        lastActive = id
        await this.attach(id)
        this.state.mode = "follow"
      }
    }
    const timer = setInterval(() => {
      void tick()
    }, this.pollMs)
    this.stopFollow = () => clearInterval(timer)
    await tick()
    return true
  }

  async detach(): Promise<boolean> {
    if (!this.isEnabled()) {
      this.state = { mode: "detached", targetId: null, lastGeometry: null }
      return true
    }
    this.stopAll()
    this.state = { mode: "detached", targetId: null, lastGeometry: null }
    this.restoreOverlayBounds()
    return true
  }

  private syncOverlayVisibility(): void {
    const win = this.getOverlayWindow()
    if (!win) return
    const shouldShow = this.lastMapped && this.lastActive
    if (shouldShow) {
      if (!win.isVisible()) win.showInactive()
    } else {
      if (win.isVisible()) win.hide()
    }
  }
}

export function registerWindowAttachIPC(service: WindowAttachService): void {
  ipcMain.handle("windowAttach.list", async () => {
    if (!service.isEnabled()) {
      throw new Error("Window attachment requires X11 session on Linux.")
    }
    return service.listWindows()
  })

  ipcMain.handle("windowAttach.attach", async (_e, id: number) => {
    if (!service.isEnabled()) {
      throw new Error("Window attachment requires X11 session on Linux.")
    }
    return service.attach(id)
  })

  ipcMain.handle("windowAttach.detach", async () => {
    return service.detach()
  })

  ipcMain.handle("windowAttach.followFocused", async (_e, enable: boolean) => {
    if (!service.isEnabled()) {
      throw new Error("Window attachment requires X11 session on Linux.")
    }
    return service.followFocused(enable)
  })

  ipcMain.handle("windowAttach.state", async () => {
    return service.getState()
  })
}

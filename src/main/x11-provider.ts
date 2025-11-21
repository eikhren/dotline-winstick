import { execFile } from "child_process"
import { promisify } from "util"
import type { Geometry, WindowRef } from "@/types/windowAttach"

const execFileAsync = promisify(execFile)

function parseDecimalId(input: string): number | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const n = Number.parseInt(trimmed, 10)
  return Number.isFinite(n) ? n : null
}

function parseHexId(input: string): number | null {
  const trimmed = input.trim()
  if (!/^0x/i.test(trimmed)) return null
  const n = Number.parseInt(trimmed, 16)
  return Number.isFinite(n) ? n : null
}

export type X11Geometry = Geometry & { mapped: boolean }

export class X11Provider {
  private wmctrl = "wmctrl"
  private xdotool = "xdotool"
  private xwininfo = "xwininfo"

  async listWindows(): Promise<WindowRef[]> {
    try {
      const { stdout } = await execFileAsync(this.wmctrl, ["-l", "-x"]) // id  desktop host  wmclass  title
      const lines = stdout.split("\n").filter(Boolean)
      const items: WindowRef[] = []
      for (const line of lines) {
        // Example: 0x0460000a  0 myhost Firefox.Firefox  Some window title
        // Capture: id(hex)  desktop  host  wmclass  title
        const m = line.match(/^(0x[\da-fA-F]+)\s+\S+\s+\S+\s+([^\s]+)\s+(.*)$/)
        if (!m) continue
        const id = parseHexId(m[1])
        const wmClass = m[2]
        const title = m[3] ?? ""
        if (id == null) continue
        items.push({ id, title, wmClass })
      }
      return items
    } catch (err) {
      // Likely missing wmctrl or not on X11
      return []
    }
  }

  async getActiveWindow(): Promise<number | null> {
    try {
      const { stdout } = await execFileAsync(this.xdotool, ["getactivewindow"]) // decimal id
      return parseDecimalId(stdout)
    } catch {
      return null
    }
  }

  async getGeometry(windowId: number): Promise<X11Geometry | null> {
    try {
      const { stdout } = await execFileAsync(this.xwininfo, ["-id", String(windowId)])
      // Parse lines like:
      //   Absolute upper-left X:  123
      //   Absolute upper-left Y:  456
      //   Width:  800
      //   Height: 600
      //   Map State: IsViewable | IsUnMapped
      let x = 0,
        y = 0,
        width = 0,
        height = 0,
        mapped = false
      for (const line of stdout.split("\n")) {
        const lx = line.trim()
        if (lx.startsWith("Absolute upper-left X:")) {
          const m = lx.match(/X:\s*(\-?\d+)/)
          if (m) x = Number.parseInt(m[1], 10)
        } else if (lx.startsWith("Absolute upper-left Y:")) {
          const m = lx.match(/Y:\s*(\-?\d+)/)
          if (m) y = Number.parseInt(m[1], 10)
        } else if (lx.startsWith("Width:")) {
          const m = lx.match(/Width:\s*(\d+)/)
          if (m) width = Number.parseInt(m[1], 10)
        } else if (lx.startsWith("Height:")) {
          const m = lx.match(/Height:\s*(\d+)/)
          if (m) height = Number.parseInt(m[1], 10)
        } else if (lx.startsWith("Map State:")) {
          mapped = lx.includes("IsViewable")
        }
      }
      if (width <= 0 || height <= 0) return null
      return { x, y, width, height, mapped }
    } catch {
      return null
    }
  }

  watchGeometry(
    windowId: number,
    opts: { intervalMs?: number; onChange: (g: X11Geometry) => void; onMissing?: () => void }
  ): () => void {
    const interval = opts.intervalMs ?? 100
    let last: X11Geometry | null = null
    const timer = setInterval(async () => {
      const g = await this.getGeometry(windowId)
      if (!g) {
        if (opts.onMissing) opts.onMissing()
        return
      }
      if (!last || g.x !== last.x || g.y !== last.y || g.width !== last.width || g.height !== last.height || g.mapped !== last.mapped) {
        last = g
        opts.onChange(g)
      }
    }, interval)
    return () => clearInterval(timer)
  }
}

export function isX11Session(): boolean {
  return process.platform === "linux" && (process.env["XDG_SESSION_TYPE"] ?? "").toLowerCase() === "x11"
}


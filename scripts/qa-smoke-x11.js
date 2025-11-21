#!/usr/bin/env node
/*
  QA Smoke Script for X11 window attachment drift
  Requires: wmctrl, xdotool, xwininfo, xprop

  Usage:
    node scripts/qa-smoke-x11.js --id <windowId> [--cycles 5] [--pause 250]
    node scripts/qa-smoke-x11.js --active

  It will:
   - Find the Dotline overlay window by title 'DotlineOverlay'
   - Move/resize the target window through a sequence
   - Sample target and overlay geometries and log drift (px) and latency (ms)

  Notes:
   - Ensure the Dotline app is running and overlay is attached to the target window.
*/

const { execFile } = require("child_process")

function execf(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) return reject(err)
      resolve({ stdout: stdout.toString(), stderr: stderr?.toString?.() || "" })
    })
  })
}

function parseArgs() {
  const args = process.argv.slice(2)
  const out = { id: null, active: false, cycles: 5, pause: 250 }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--id") out.id = Number.parseInt(args[++i], 10)
    else if (a === "--active") out.active = true
    else if (a === "--cycles") out.cycles = Number.parseInt(args[++i], 10)
    else if (a === "--pause") out.pause = Number.parseInt(args[++i], 10)
  }
  return out
}

function parseHexId(s) {
  const m = s.trim().match(/^0x([0-9a-fA-F]+)$/)
  return m ? parseInt(m[1], 16) : null
}

function parseGeometryFromXwininfo(out) {
  let x = 0, y = 0, w = 0, h = 0
  for (const line of out.split("\n")) {
    const lx = line.trim()
    if (lx.startsWith("Absolute upper-left X:")) {
      const m = lx.match(/X:\s*(-?\d+)/)
      if (m) x = parseInt(m[1], 10)
    } else if (lx.startsWith("Absolute upper-left Y:")) {
      const m = lx.match(/Y:\s*(-?\d+)/)
      if (m) y = parseInt(m[1], 10)
    } else if (lx.startsWith("Width:")) {
      const m = lx.match(/Width:\s*(\d+)/)
      if (m) w = parseInt(m[1], 10)
    } else if (lx.startsWith("Height:")) {
      const m = lx.match(/Height:\s*(\d+)/)
      if (m) h = parseInt(m[1], 10)
    }
  }
  return { x, y, width: w, height: h }
}

async function getOverlayWindowId() {
  const { stdout } = await execf("wmctrl", ["-l"])
  // Find by title 'DotlineOverlay'
  for (const line of stdout.split("\n")) {
    if (!line.includes("DotlineOverlay")) continue
    const m = line.trim().match(/^(0x[0-9a-fA-F]+)/)
    if (m) {
      const id = parseHexId(m[1])
      if (id) return id
    }
  }
  return null
}

async function getActiveWindowId() {
  try {
    const { stdout } = await execf("xdotool", ["getactivewindow"]) // decimal
    const n = parseInt(stdout.trim(), 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

async function getGeometry(id) {
  const { stdout } = await execf("xwininfo", ["-id", String(id)])
  return parseGeometryFromXwininfo(stdout)
}

async function moveAndResize(id, x, y, w, h) {
  await execf("xdotool", ["windowmove", String(id), String(x), String(y)])
  await execf("xdotool", ["windowsize", String(id), String(w), String(h)])
}

function now() {
  const [s, ns] = process.hrtime()
  return s * 1000 + ns / 1e6
}

async function main() {
  const args = parseArgs()
  let targetId = args.id
  if (args.active || !targetId) {
    targetId = await getActiveWindowId()
  }
  if (!targetId) {
    console.error("No target window id provided or found as active.")
    process.exit(1)
  }
  const overlayId = await getOverlayWindowId()
  if (!overlayId) {
    console.error("Could not find Dotline overlay window (title 'DotlineOverlay').")
    process.exit(2)
  }

  console.log(`Using target id=${targetId}, overlay id=${overlayId}`)
  const base = await getGeometry(targetId)

  const moves = [
    { dx: 0, dy: 0, dw: 0, dh: 0 },
    { dx: 100, dy: 80, dw: 120, dh: 60 },
    { dx: -150, dy: 120, dw: 240, dh: 120 },
    { dx: 200, dy: -100, dw: -160, dh: -100 },
    { dx: 0, dy: 0, dw: 0, dh: 0 }
  ]

  let maxPxDrift = 0
  let maxLatency = 0
  let missed = 0

  for (let c = 0; c < args.cycles; c++) {
    for (const m of moves) {
      const gx = base.x + m.dx
      const gy = base.y + m.dy
      const gw = Math.max(200, base.width + m.dw)
      const gh = Math.max(200, base.height + m.dh)
      await moveAndResize(targetId, gx, gy, gw, gh)

      const start = now()
      let aligned = false
      let stepMax = 0

      const deadline = start + 1500
      while (now() < deadline) {
        const tg = await getGeometry(targetId)
        const og = await getGeometry(overlayId)
        const dx = Math.abs((og.x ?? 0) - (tg.x ?? 0))
        const dy = Math.abs((og.y ?? 0) - (tg.y ?? 0))
        const dw = Math.abs((og.width ?? 0) - (tg.width ?? 0))
        const dh = Math.abs((og.height ?? 0) - (tg.height ?? 0))
        const px = Math.max(dx, dy, dw, dh)
        stepMax = Math.max(stepMax, px)
        if (px <= 1) {
          aligned = true
          break
        }
        await new Promise((r) => setTimeout(r, 20))
      }

      const latency = now() - start
      maxLatency = Math.max(maxLatency, latency)
      maxPxDrift = Math.max(maxPxDrift, stepMax)
      if (!aligned) missed++
      await new Promise((r) => setTimeout(r, args.pause))
    }
  }

  console.log(`\nResults:`)
  console.log(`  Max pixel drift: ${maxPxDrift}px`)
  console.log(`  Max latency: ${Math.round(maxLatency)}ms`)
  console.log(`  Missed alignments: ${missed}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(99)
})


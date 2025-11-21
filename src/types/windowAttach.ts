export type WindowRef = {
  id: number
  title: string
  wmClass: string
}

export type Geometry = {
  x: number
  y: number
  width: number
  height: number
}

export type AttachMode = "attached" | "detached" | "follow"

export type AttachState = {
  mode: AttachMode
  targetId: number | null
  lastGeometry: Geometry | null
}


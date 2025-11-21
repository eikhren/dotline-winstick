import { useEffect, useMemo, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { WindowRef } from "@/types/windowAttach"

function Settings() {
  const [rpcEnabled, setRpcEnabled] = useState<boolean>(true)
  const [checking, setChecking] = useState(false)
  // Window attachment state
  const [unsupported, setUnsupported] = useState<boolean>(false)
  const [windows, setWindows] = useState<WindowRef[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [followFocused, setFollowFocused] = useState<boolean>(false)

  useEffect(() => {
    const disabled = localStorage.getItem("discordRpcDisabled")
    setRpcEnabled(!(disabled === "true"))
  }, [])

  const handleToggleRpc = async (checked: boolean) => {
    setRpcEnabled(checked)
    if (checked) {
      localStorage.removeItem("discordRpcDisabled")
      await window.electron.ipcRenderer.invoke("start-discord-rpc")
    } else {
      localStorage.setItem("discordRpcDisabled", "true")
      await window.electron.ipcRenderer.invoke("stop-discord-rpc")
    }
  }

  // const openLogs = async () => {
  //   await window.electron.ipcRenderer.invoke('app:open-logs')
  // }

  const checkForUpdates = async () => {
    try {
      setChecking(true)
      const res = await window.electron.ipcRenderer.invoke("updater:check")
      if (res?.ok && !res.updateInfo) {
        toast.success("You're up to date")
      }
    } catch (e) {
      toast.error(String(e))
    } finally {
      setChecking(false)
    }
  }

  // --- Window Attachment Logic ---
  const loadPersisted = () => {
    try {
      const rawId = localStorage.getItem("windowAttachment.targetId")
      const rawFollow = localStorage.getItem("windowAttachment.followFocused")
      const id = rawId ? Number.parseInt(rawId, 10) : null
      const follow = rawFollow === "true"
      setSelectedId(Number.isFinite(id as number) ? (id as number) : null)
      setFollowFocused(!!follow)
    } catch {}
  }

  const persist = (id: number | null, follow: boolean) => {
    try {
      if (id == null) localStorage.removeItem("windowAttachment.targetId")
      else localStorage.setItem("windowAttachment.targetId", String(id))
      localStorage.setItem("windowAttachment.followFocused", follow ? "true" : "false")
    } catch {}
  }

  const fetchWindows = async () => {
    try {
      const list = (await window.electron.ipcRenderer.invoke("windowAttach.list")) as WindowRef[]
      setWindows(list)
      setUnsupported(false)
    } catch (e) {
      setUnsupported(true)
      setWindows([])
    }
  }

  useEffect(() => {
    loadPersisted()
    void fetchWindows()
  }, [])

  useEffect(() => {
    // Apply persisted behavior on start
    const apply = async () => {
      try {
        if (unsupported) return
        if (followFocused) {
          await window.electron.ipcRenderer.invoke("windowAttach.followFocused", true)
        } else if (selectedId != null) {
          await window.electron.ipcRenderer.invoke("windowAttach.attach", selectedId)
        } else {
          await window.electron.ipcRenderer.invoke("windowAttach.detach")
        }
      } catch {}
    }
    void apply()
  }, [unsupported])

  const windowLabel = useMemo(() => {
    return (w: WindowRef) => {
      const cls = w.wmClass?.split(".")?.pop() || w.wmClass || ""
      const title = w.title?.length > 80 ? w.title.slice(0, 77) + "…" : w.title
      return `${title || "(untitled)"} — ${cls} [${w.id}]`
    }
  }, [])

  const onChangeSelection = async (value: string) => {
    const id = value === "none" ? null : Number.parseInt(value, 10)
    setSelectedId(id)
    // Selecting a concrete window disables follow mode
    setFollowFocused(false)
    persist(id, false)
    try {
      if (id == null) {
        await window.electron.ipcRenderer.invoke("windowAttach.detach")
      } else {
        await window.electron.ipcRenderer.invoke("windowAttach.attach", id)
      }
    } catch (e) {
      toast.error(String(e))
    }
  }

  const onToggleFollow = async (checked?: boolean) => {
    const next = !!checked
    setFollowFocused(next)
    persist(selectedId, next)
    try {
      if (next) {
        await window.electron.ipcRenderer.invoke("windowAttach.followFocused", true)
      } else if (selectedId != null) {
        await window.electron.ipcRenderer.invoke("windowAttach.attach", selectedId)
      } else {
        await window.electron.ipcRenderer.invoke("windowAttach.detach")
      }
    } catch (e) {
      toast.error(String(e))
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Window attachment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {unsupported ? (
            <p className="text-sm text-muted-foreground">
              Window attachment requires an X11 session on Linux. On Wayland, this feature is
              disabled.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <Label className="whitespace-nowrap">Attach to window</Label>
                <div className="flex items-center gap-2">
                  <Select
                    value={selectedId == null ? "none" : String(selectedId)}
                    onValueChange={onChangeSelection}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a window" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {windows.map((w) => (
                        <SelectItem key={w.id} value={String(w.id)}>
                          {windowLabel(w)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button variant="outline" onClick={() => void fetchWindows()}>
                    Refresh
                  </Button>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <Label>Follow focused window</Label>
                <Switch checked={followFocused} onCheckedChange={(v) => onToggleFollow(!!v)} />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Discord Rich Presence</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <Label>Enable Discord RPC</Label>
            <Switch checked={rpcEnabled} onCheckedChange={(v) => handleToggleRpc(!!v)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Updates</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">Check for updates to Dotline.</p>
          </div>
          <Button variant="outline" onClick={checkForUpdates} disabled={checking}>
            {checking ? "Checking…" : "Check for updates"}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Support</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <Label>Report a issue or Request a feature </Label>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  try {
                    window.open("https://discord.com/invite/En5YJYWj3Z", "_blank")
                  } catch {}
                }}
              >
                Support (on Discord)
              </Button>
              <Button
                onClick={() => {
                  try {
                    window.open("https://github.com/Parcoil/dotline/issues/new/choose", "_blank")
                  } catch {}
                }}
              >
                Report / Request (on GitHub)
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* <Card>
        <CardHeader>
          <CardTitle>Logs</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">Open the application logs folder.</p>
          </div>
          <Button variant="outline" onClick={openLogs}>
            Open Logs Folder
          </Button>
        </CardContent>
      </Card> */}
    </div>
  )
}

export default Settings

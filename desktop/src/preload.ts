import { contextBridge, ipcRenderer } from "electron"

/**
 * The only bridge between a page and this app, and deliberately a small one: nothing here reads or
 * writes anything, so a page that calls it can at most raise the window or ask for a reconnect.
 *
 * `focusWindow` exists because `window.focus()` does not raise an Electron window the way it raises a
 * browser tab.
 */
contextBridge.exposeInMainWorld("look4Desktop", {
	focusWindow: () => ipcRenderer.send("look4-desktop:focus-window"),
	retry: () => ipcRenderer.send("look4-desktop:retry")
})

import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The UI is a static SPA in web/; the look4 server serves web/dist in production.
// In dev, /api and /media go to the backend (`look4 start`, or `scripts/mock-api.ts`).
const api = process.env.LOOK4_API ?? "http://127.0.0.1:4040"

export default defineConfig({
	root: "web",
	plugins: [react()],
	build: {
		outDir: "dist",
		emptyOutDir: true
	},
	server: {
		// "localhost" can bind ::1 alone, which neither the desktop window's probe of 127.0.0.1 nor a
		// Windows Electron across WSL's loopback forwarding reaches; a browser on localhost still does.
		host: "127.0.0.1",
		proxy: {
			"/api": { target: api, changeOrigin: false },
			"/media": { target: api, changeOrigin: false }
		}
	}
})

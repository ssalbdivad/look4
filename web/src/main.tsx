// Brand tokens first: every other stylesheet reads the --l4-* custom properties.
import "./brand.css"
import "@fontsource-variable/fredoka"
import "@fontsource-variable/nunito"
import "./app.css"
import "./setup.css"
import "./live.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import { KeyboardProvider } from "./keyboard.tsx"

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		{/* one keyboard runtime for the whole app (and the pop-out window, which is its own app instance) */}
		<KeyboardProvider>
			<App />
		</KeyboardProvider>
	</StrictMode>
)

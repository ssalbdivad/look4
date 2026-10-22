import { Icon } from "../components/Icon.tsx"
import { Dialog } from "../feedback.tsx"

/** How to watch from outside the home safely (Tailscale), and the one thing never to do (port forwarding). */
export const AwayDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => (
	<Dialog open={open} title="Watching from away" onClose={onClose} size="sm">
		<div className="lv-away">
			<p>
				The safe way is <strong>Tailscale</strong>, a free app that links your own devices privately, as if your phone were still on
				the home Wi-Fi:
			</p>
			<ol>
				<li>Install Tailscale on this computer and on your phone, and sign in to both with the same account.</li>
				<li>
					Let look4 answer other devices: set <code>server.host</code> to <code>0.0.0.0</code> in look4.config.json, then restart look4.
				</li>
				<li>
					On your phone, open <code>http://&lt;this computer's Tailscale name&gt;:4040/live</code>. The Tailscale app lists the name.
				</li>
			</ol>
			<p className="note">
				<Icon name="alert" size={18} />
				<span>
					<strong>Never “port forward” the camera</strong> (or look4) on your router. That puts the camera's login page on the open
					internet, where bots try passwords around the clock.
				</span>
			</p>
		</div>
	</Dialog>
)

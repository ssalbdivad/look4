#!/usr/bin/env node
// `look4`. node:sqlite prints an ExperimentalWarning the moment it is imported, and
// static imports are hoisted above any code here, so this file only installs a
// filter for that one warning and then dynamically imports the real CLI.

const printers = process.listeners("warning")
process.removeAllListeners("warning")
process.on("warning", w => {
	if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return
	for (const print of printers) print(w)
})

const { main } = await import("./cli.ts")
const code = await main(process.argv.slice(2))
// let piped stdout drain before exiting; lingering handles (model threads, timers) must not keep a finished command alive
await new Promise<void>(resolve => process.stdout.write("", () => resolve()))
process.exit(code)

import type { WebviewApi } from "vscode-webview"

import { WebviewMessage } from "@roo/WebviewMessage"
import { WsTransport, getWsTransport } from "./wsTransport"

/**
 * A utility wrapper around the acquireVsCodeApi() function, which enables
 * message passing and state management between the webview and extension
 * contexts.
 *
 * When running in standalone browser mode (via the RemoteWebServer), this
 * automatically falls back to WebSocket-based transport.
 *
 * This utility also enables webview code to be run in a web browser-based
 * dev server by using native web browser features that mock the functionality
 * enabled by acquireVsCodeApi.
 */
class VSCodeAPIWrapper {
	private readonly vsCodeApi: WebviewApi<unknown> | undefined
	private wsTransport: WsTransport | null = null

	constructor() {
		// Check if the acquireVsCodeApi function exists in the current development
		// context (i.e. VS Code development window or web browser)
		if (typeof acquireVsCodeApi === "function") {
			this.vsCodeApi = acquireVsCodeApi()
		}
	}

	/**
	 * Post a message (i.e. send arbitrary data) to the owner of the webview.
	 *
	 * @remarks
	 * - In VS Code webview: Uses postMessage API.
	 * - In standalone browser (RemoteWebUI): Uses WebSocket transport.
	 * - In dev browser without WebSocket: Logs to console.
	 *
	 * @param message Arbitrary data (must be JSON serializable) to send to the extension context.
	 */
	public postMessage(message: WebviewMessage) {
		if (this.vsCodeApi) {
			this.vsCodeApi.postMessage(message)
		} else if (this.getWsTransport()) {
			this.getWsTransport()!.postMessage(message)
		} else {
			console.log("[VsCodeAPI] WebSocket not available, message logged:", message.type)
		}
	}

	/**
	 * Get the persistent state stored for this webview.
	 *
	 * @remarks When running webview source code inside a web browser, getState will retrieve state
	 * from local storage (https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage).
	 *
	 * @return The current state or `undefined` if no state has been set.
	 */
	public getState(): unknown | undefined {
		if (this.vsCodeApi) {
			return this.vsCodeApi.getState()
		} else {
			const state = localStorage.getItem("vscodeState")
			return state ? JSON.parse(state) : undefined
		}
	}

	/**
	 * Set the persistent state stored for this webview.
	 *
	 * @remarks When running webview source code inside a web browser, setState will set the given
	 * state using local storage (https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage).
	 *
	 * @param newState New persisted state. This must be a JSON serializable object. Can be retrieved
	 * using {@link getState}.
	 *
	 * @return The new state.
	 */
	public setState<T extends unknown | undefined>(newState: T): T {
		if (this.vsCodeApi) {
			return this.vsCodeApi.setState(newState)
		} else {
			localStorage.setItem("vscodeState", JSON.stringify(newState))
			return newState
		}
	}

	/**
	 * Initialize the WebSocket transport for standalone browser mode.
	 * Called once by ExtensionStateContext when running outside VS Code.
	 *
	 * @param handler Callback that receives incoming state updates from the extension.
	 */
	public connectWebSocket(handler: (message: any) => void): void {
		const transport = this.getWsTransport()
		if (transport) {
			transport.connect(handler)
		}
	}

	/**
	 * Check if we're running in standalone browser mode (not VS Code webview).
	 */
	public isStandalone(): boolean {
		return typeof acquireVsCodeApi !== "function"
	}

	// ─── Private helpers ────────────────────────────────────────────────

	private getWsTransport(): WsTransport | null {
		if (this.wsTransport) return this.wsTransport

		try {
			this.wsTransport = getWsTransport()
			return this.wsTransport
		} catch {
			return null
		}
	}
}

// Exports class singleton to prevent multiple invocations of acquireVsCodeApi.
export const vscode = new VSCodeAPIWrapper()

/**
 * WebSocket transport adapter for webview-ui.
 *
 * When running in standalone mode (via RemoteWebServer), the webview uses this
 * WebSocket-based transport instead of VS Code's postMessage API.
 *
 * The transport auto-detects the environment:
 * - In VS Code webview: Uses the existing vscode.postMessage() flow
 * - In standalone browser: Connects via WebSocket to the extension's server
 */

import type { WebviewMessage } from "@roo/WebviewMessage"
import type { ExtensionState } from "@roo-code/types"

/**
 * Callback type for incoming extension messages (state updates).
 */
export type IncomingMessageHandler = (message: ExtensionState) => void

/**
 * WebSocket transport for standalone browser access.
 *
 * Connects to the RemoteWebServer's WebSocket endpoint and
 * provides the same postMessage/listener API as VS Code's webview.
 */
export class WsTransport {
	private ws: WebSocket | null = null
	private clientId: string | null = null
	private incomingHandler: IncomingMessageHandler | null = null
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null
	private url: string
	private reconnectAttempts = 0
	private maxReconnectAttempts = 10
	private reconnectDelay = 1000

	constructor() {
		// Determine WebSocket URL from location
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
		const host = window.location.host
		this.url = `${protocol}//${host}/ws`
	}

	/**
	 * Check if we're running in standalone browser mode (not VS Code webview).
	 */
	static isStandalone(): boolean {
		return typeof acquireVsCodeApi !== "function"
	}

	/**
	 * Connect to the WebSocket server and set up message handling.
	 */
	connect(handler: IncomingMessageHandler): void {
		this.incomingHandler = handler
		this.doConnect()
	}

	/**
	 * Send a message to the extension via WebSocket.
	 */
	postMessage(message: WebviewMessage): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(message))
		} else {
			console.warn("[WsTransport] Not connected, message queued:", message.type)
		}
	}

	/**
	 * Get the client ID assigned by the server.
	 */
	getClientId(): string | null {
		return this.clientId
	}

	/**
	 * Disconnect and clean up.
	 */
	disconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
		if (this.ws) {
			this.ws.close(1000, "Client disconnecting")
			this.ws = null
		}
		this.clientId = null
		this.reconnectAttempts = 0
	}

	// ─── Private helpers ────────────────────────────────────────────────

	private doConnect(): void {
		try {
			this.ws = new WebSocket(this.url)
		} catch (err) {
			console.error("[WsTransport] Failed to create WebSocket:", err)
			this.scheduleReconnect()
			return
		}

		this.ws.onopen = () => {
			console.log("[WsTransport] Connected to Zoo Code WebUI server")
			this.reconnectAttempts = 0
		}

		this.ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data)

				// Handle the initial handshake
				if (data.type === "transportReady") {
					this.clientId = data.clientId
					console.log("[WsTransport] Received client ID:", this.clientId)
					return
				}

				// Forward state updates to the registered handler
				if (this.incomingHandler) {
					this.incomingHandler(data as ExtensionState)
				}
			} catch (err) {
				console.error("[WsTransport] Error processing message:", err)
			}
		}

		this.ws.onclose = (event) => {
			console.log(`[WsTransport] Disconnected (code: ${event.code})`)
			this.ws = null
			this.clientId = null

			// Only reconnect if not intentionally closed
			if (event.code !== 1000) {
				this.scheduleReconnect()
			}
		}

		this.ws.onerror = (err) => {
			console.error("[WsTransport] WebSocket error:", err)
		}
	}

	private scheduleReconnect(): void {
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			console.error("[WsTransport] Max reconnect attempts reached")
			return
		}

		const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), 30000)
		this.reconnectAttempts++

		console.log(
			`[WsTransport] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`,
		)

		this.reconnectTimer = setTimeout(() => {
			this.doConnect()
		}, delay)
	}
}

/**
 * Singleton instance, created lazily when in standalone mode.
 */
let wsTransportInstance: WsTransport | null = null

export function getWsTransport(): WsTransport {
	if (!wsTransportInstance) {
		wsTransportInstance = new WsTransport()
	}
	return wsTransportInstance
}

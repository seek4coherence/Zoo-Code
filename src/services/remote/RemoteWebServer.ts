/**
 * Remote WebServer for Zoo Code.
 *
 * Provides a standalone HTTP server that:
 * 1. Serves the built webview-ui as a standalone web application
 * 2. Accepts WebSocket connections for real-time message transport
 * 3. Supports authentication when remote access is enabled
 *
 * Architecture is inspired by AionUi's webserver (src/process/webserver/index.ts)
 * but adapted for VS Code extension lifecycle and Zoo Code's message types.
 */

import * as http from "http"
import * as path from "path"
import * as fs from "fs"
import * as crypto from "crypto"
import * as vscode from "vscode"
import express from "express"
import { WebSocketServer, WebSocket } from "ws"
import type { OutputChannel } from "vscode"

import type { WebUIConfig, TransportMessageHandler, SessionToken } from "./types"

/**
 * Parse a cookie string into a key-value map.
 */
function parseCookies(cookieHeader: string): Record<string, string> {
	const cookies: Record<string, string> = {}
	cookieHeader.split(";").forEach((pair) => {
		const [key, ...rest] = pair.trim().split("=")
		if (key) {
			cookies[key] = decodeURIComponent(rest.join("="))
		}
	})
	return cookies
}

/**
 * Map of active WebSocket connections, keyed by client ID.
 */
type WsClientMap = Map<string, WebSocket>

export class RemoteWebServer {
	private server: http.Server | null = null
	private wss: WebSocketServer | null = null
	private app: express.Express
	private config: WebUIConfig
	private clients: WsClientMap = new Map()
	private messageHandler: TransportMessageHandler | null = null
	private outputChannel: OutputChannel
	private context: vscode.ExtensionContext
	private sessions: Map<string, SessionToken> = new Map()

	constructor(config: WebUIConfig, context: vscode.ExtensionContext, outputChannel: OutputChannel) {
		this.config = config
		this.context = context
		this.outputChannel = outputChannel
		this.app = express()
	}

	/**
	 * Set the handler for incoming messages from remote transports.
	 * Called by MessageBridge during initialization.
	 */
	setMessageHandler(handler: TransportMessageHandler): void {
		this.messageHandler = handler
	}

	/**
	 * Start the HTTP and WebSocket server.
	 */
	async start(): Promise<void> {
		if (!this.config.enabled) {
			this.outputChannel.appendLine("[RemoteWebServer] WebUI is disabled, skipping start")
			return
		}

		this.setupMiddleware()
		this.setupRoutes()
		this.setupErrorHandler()

		this.server = http.createServer(this.app)
		this.wss = new WebSocketServer({ noServer: true })

		this.setupWebSocket()

		const host = this.config.allowRemote ? "0.0.0.0" : "127.0.0.1"

		return new Promise((resolve, reject) => {
			this.server!.listen(this.config.port, host, () => {
				const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${this.config.port}`
				this.outputChannel.appendLine(
					`[RemoteWebServer] Zoo Code WebUI started on ${url}` +
						(this.config.allowRemote ? ` (remote access enabled, listening on ${host})` : ""),
				)

				if (this.config.allowRemote && !this.config.password) {
					this.outputChannel.appendLine(
						"[RemoteWebServer] WARNING: Remote access enabled without password! " +
							"Set zooCode.remoteAccess.webui.password to secure your instance.",
					)
				}

				resolve()
			})

			this.server!.on("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "EADDRINUSE") {
					this.outputChannel.appendLine(
						`[RemoteWebServer] Port ${this.config.port} is in use. ` +
							"Change zooCode.remoteAccess.webui.port to a different port.",
					)
				}
				reject(err)
			})
		})
	}

	/**
	 * Stop the server and close all connections.
	 */
	async stop(): Promise<void> {
		this.outputChannel.appendLine("[RemoteWebServer] Shutting down...")

		// Close all WebSocket connections
		for (const [clientId, ws] of this.clients) {
			try {
				ws.close(1000, "Server shutting down")
			} catch {
				// Best-effort
			}
		}
		this.clients.clear()
		this.sessions.clear()

		if (this.wss) {
			this.wss.close()
			this.wss = null
		}

		if (this.server) {
			return new Promise((resolve) => {
				this.server!.close(() => {
					this.outputChannel.appendLine("[RemoteWebServer] Server stopped")
					this.server = null
					resolve()
				})
			})
		}
	}

	/**
	 * Send a state update to all connected WebSocket clients.
	 * Called by ClineProvider when the extension state changes.
	 */
	broadcastState(state: unknown): void {
		const message = JSON.stringify(state)
		for (const [clientId, ws] of this.clients) {
			if (ws.readyState === WebSocket.OPEN) {
				try {
					ws.send(message)
				} catch {
					this.clients.delete(clientId)
				}
			} else {
				this.clients.delete(clientId)
			}
		}
	}

	/**
	 * Send a state update to a specific WebSocket client.
	 */
	sendToClient(clientId: string, data: unknown): void {
		const ws = this.clients.get(clientId)
		if (ws && ws.readyState === WebSocket.OPEN) {
			try {
				ws.send(JSON.stringify(data))
			} catch {
				this.clients.delete(clientId)
			}
		}
	}

	// ─── Private helpers ────────────────────────────────────────────────

	private setupMiddleware(): void {
		this.app.use(express.json({ limit: "10mb" }))

		// Serve the webview-ui build output
		const webviewDist = this.resolveWebviewDist()
		if (webviewDist) {
			this.outputChannel.appendLine(`[RemoteWebServer] Serving webview from: ${webviewDist}`)
			this.app.use(express.static(webviewDist))

			// SPA fallback: serve index.html for all non-API routes
			this.app.get("*", (req: express.Request, res: express.Response, next: express.NextFunction) => {
				// Skip API/auth routes
				if (req.path.startsWith("/api/") || req.path.startsWith("/auth/")) {
					return next()
				}
				// Skip static files that exist
				const filePath = path.join(webviewDist, req.path)
				if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
					return next()
				}
				// SPA fallback
				res.sendFile(path.join(webviewDist, "index.html"))
			})
		} else {
			this.outputChannel.appendLine(
				"[RemoteWebServer] WARNING: webview-ui build not found. " +
					"Run 'pnpm build:webview' in the webview-ui directory to build the web UI.",
			)
		}
	}

	private setupRoutes(): void {
		// Health check
		this.app.get("/api/health", (_req: express.Request, res: express.Response) => {
			res.json({ status: "ok", clients: this.clients.size, timestamp: Date.now() })
		})
	}

	private setupErrorHandler(): void {
		this.app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
			this.outputChannel.appendLine(`[RemoteWebServer] Error: ${err.message}`)
			res.status(500).json({ error: "Internal server error" })
		})
	}

	private setupWebSocket(): void {
		if (!this.server || !this.wss) return

		this.server.on("upgrade", (req, socket, head) => {
			const url = new URL(req.url || "/", `http://${req.headers.host}`)

			// Only handle /ws path for WebSocket connections
			if (url.pathname !== "/ws") {
				socket.destroy()
				return
			}

			// Authenticate if remote access is enabled
			if (this.config.allowRemote && this.config.password) {
				const cookies = parseCookies(req.headers.cookie || "")
				const token = cookies["zoo_session"]
				if (!token || !this.validateSession(token)) {
					// Send 401 via HTTP before upgrade
					socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
					socket.destroy()
					return
				}
			}

			this.wss!.handleUpgrade(req, socket, head, (ws) => {
				this.wss!.emit("connection", ws, req)
			})
		})

		this.wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
			const clientId = crypto.randomUUID()
			this.clients.set(clientId, ws)
			this.outputChannel.appendLine(
				`[RemoteWebServer] WebSocket client connected: ${clientId}` + ` (${req.socket.remoteAddress})`,
			)

			// Send initial handshake
			ws.send(
				JSON.stringify({
					type: "transportReady",
					transport: "websocket",
					clientId,
				}),
			)

			ws.on("message", async (data: Buffer) => {
				try {
					const parsed = JSON.parse(data.toString())
					if (this.messageHandler) {
						await this.messageHandler({
							message: parsed,
							meta: {
								transport: "websocket",
								clientId,
								timestamp: Date.now(),
							},
						})
					}
				} catch (err) {
					this.outputChannel.appendLine(
						`[RemoteWebServer] Error processing WS message: ${err instanceof Error ? err.message : String(err)}`,
					)
				}
			})

			ws.on("close", () => {
				this.clients.delete(clientId)
				this.outputChannel.appendLine(`[RemoteWebServer] WebSocket client disconnected: ${clientId}`)
			})

			ws.on("error", (err: Error) => {
				this.outputChannel.appendLine(`[RemoteWebServer] WebSocket error for ${clientId}: ${err.message}`)
				this.clients.delete(clientId)
			})
		})
	}

	/**
	 * Resolve the path to the built webview-ui distribution.
	 * Looks for the built assets in the standard vite build output location.
	 */
	private resolveWebviewDist(): string | null {
		// In production, the webview-ui is built into the extension's dist folder
		const possiblePaths = [
			// Built alongside the extension (for production)
			path.join(this.context.extensionPath, "dist", "webview"),
			// Vite build output (for development)
			path.join(this.context.extensionPath, "webview-ui", "dist"),
			// Alternative: built into the extension's webview-dist folder
			path.join(this.context.extensionPath, "webview-dist"),
		]

		for (const p of possiblePaths) {
			if (fs.existsSync(path.join(p, "index.html"))) {
				return p
			}
		}

		// If none found, log available paths for debugging
		this.outputChannel.appendLine(
			"[RemoteWebServer] Checked paths for webview build:\n" +
				possiblePaths.map((p) => `  - ${p} (${fs.existsSync(p) ? "exists" : "missing"})`).join("\n"),
		)

		return null
	}

	/**
	 * Simple session token validation for remote access.
	 * In production, this would use JWT or similar.
	 */
	private validateSession(token: string): boolean {
		const session = this.sessions.get(token)
		if (!session) return false
		if (Date.now() / 1000 > session.exp) {
			this.sessions.delete(token)
			return false
		}
		return true
	}
}

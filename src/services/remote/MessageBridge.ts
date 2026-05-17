/**
 * MessageBridge - Central coordinator for remote message transports.
 *
 * Routes messages between ClineProvider and remote transports (WebSocket, Discord).
 * This is the glue that makes the existing VS Code webview message protocol
 * work over alternative transports without changing the ClineProvider's core logic.
 *
 * Flow:
 *   ClineProvider.postMessageToWebview()
 *     → MessageBridge.broadcastState()
 *       → RemoteWebServer.broadcastState()    (all WS clients)
 *       → DiscordBot.sendToUser()             (authorized Discord user)
 *
 *   Remote transport (WS/Discord) message
 *     → MessageBridge.handleTransportMessage()
 *       → ClineProvider.handleWebviewMessage() (same handler as VS Code webview)
 */

import * as vscode from "vscode"
import type { OutputChannel } from "vscode"
import type { WebviewMessage } from "@roo/WebviewMessage"
import type { RemoteAccessConfig, TransportMessage, TransportMessageHandler } from "./types"
import { DEFAULT_REMOTE_ACCESS_CONFIG, CONFIG_SECTION } from "./types"
import { RemoteWebServer } from "./RemoteWebServer"
import { DiscordBot } from "./DiscordBot"

/**
 * Callback type for handling webview messages.
 * Matches the signature of ClineProvider's message handler.
 */
export type WebviewMessageCallback = (message: WebviewMessage) => Promise<void>

/**
 * Callback type for posting state to webviews.
 * Matches ClineProvider.postStateToWebview().
 */
export type PostStateCallback = () => Promise<void> | void

export class MessageBridge {
	private webServer: RemoteWebServer
	private discordBot: DiscordBot
	private outputChannel: OutputChannel
	private config: RemoteAccessConfig
	private messageCallback: WebviewMessageCallback | null = null

	constructor(context: vscode.ExtensionContext, outputChannel: OutputChannel) {
		this.outputChannel = outputChannel
		this.config = this.loadConfig()
		this.webServer = new RemoteWebServer(this.config.webui, context, outputChannel)
		this.discordBot = new DiscordBot(this.config.discord, outputChannel)
	}

	/**
	 * Initialize all remote transports and wire them up.
	 *
	 * @param messageHandler Callback that handles incoming messages (ClineProvider.handleWebviewMessage)
	 */
	async initialize(messageHandler: WebviewMessageCallback): Promise<void> {
		this.messageCallback = messageHandler

		// Create the transport message handler that both transports use
		const transportHandler: TransportMessageHandler = async (msg: TransportMessage) => {
			if (this.messageCallback) {
				await this.messageCallback(msg.message)
			}
		}

		this.webServer.setMessageHandler(transportHandler)
		this.discordBot.setMessageHandler(transportHandler)

		// Start transports in parallel
		await Promise.all([this.webServer.start(), this.discordBot.start()])

		this.outputChannel.appendLine(
			"[MessageBridge] Remote transports initialized " +
				`(WebUI: ${this.config.webui.enabled ? "enabled" : "disabled"}, ` +
				`Discord: ${this.config.discord.enabled ? "enabled" : "disabled"})`,
		)
	}

	/**
	 * Broadcast extension state to all remote transports.
	 * Called by ClineProvider whenever the webview state changes.
	 */
	broadcastState(state: unknown): void {
		this.webServer.broadcastState(state)

		// For Discord, we only forward user-facing messages, not every state update.
		// The actual message forwarding is handled by the chat response path.
		// State updates (like settings changes) are too verbose for Discord.
	}

	/**
	 * Send a message to a specific Discord user.
	 * Used for chat responses and approval prompts.
	 */
	async sendToDiscord(content: string): Promise<void> {
		await this.discordBot.sendToUser(content)
	}

	/**
	 * Send a message to a specific WebSocket client.
	 */
	sendToWsClient(clientId: string, data: unknown): void {
		this.webServer.sendToClient(clientId, data)
	}

	/**
	 * Shut down all remote transports.
	 */
	async dispose(): Promise<void> {
		this.outputChannel.appendLine("[MessageBridge] Disposing remote transports...")
		await Promise.all([this.webServer.stop(), this.discordBot.stop()])
		this.messageCallback = null
	}

	/**
	 * Reload configuration from VS Code settings.
	 */
	reloadConfig(): void {
		this.config = this.loadConfig()
	}

	// ─── Private helpers ────────────────────────────────────────────────

	private loadConfig(): RemoteAccessConfig {
		const workspaceConfig = vscode.workspace.getConfiguration()
		const webuiConfig = workspaceConfig.get<any>(`${CONFIG_SECTION}.webui`) || {}
		const discordConfig = workspaceConfig.get<any>(`${CONFIG_SECTION}.discord`) || {}

		return {
			webui: {
				enabled: webuiConfig.enabled ?? DEFAULT_REMOTE_ACCESS_CONFIG.webui.enabled,
				port: webuiConfig.port ?? DEFAULT_REMOTE_ACCESS_CONFIG.webui.port,
				allowRemote: webuiConfig.allowRemote ?? DEFAULT_REMOTE_ACCESS_CONFIG.webui.allowRemote,
				password: webuiConfig.password,
				sessionTimeoutSeconds:
					webuiConfig.sessionTimeoutSeconds ?? DEFAULT_REMOTE_ACCESS_CONFIG.webui.sessionTimeoutSeconds,
			},
			discord: {
				enabled: discordConfig.enabled ?? DEFAULT_REMOTE_ACCESS_CONFIG.discord.enabled,
				botToken: discordConfig.botToken ?? DEFAULT_REMOTE_ACCESS_CONFIG.discord.botToken,
				authorizedUserId:
					discordConfig.authorizedUserId ?? DEFAULT_REMOTE_ACCESS_CONFIG.discord.authorizedUserId,
			},
		}
	}
}

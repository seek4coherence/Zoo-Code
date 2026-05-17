/**
 * Discord Bot integration for Zoo Code.
 *
 * Allows users to interact with their Zoo Code agent through private Discord DMs.
 * Only responds to the authorized user ID configured in settings.
 *
 * Architecture:
 * - discord.js client connects to Discord Gateway on extension activation
 * - DMs from the authorized user are forwarded to the MessageBridge
 * - Agent responses and approval prompts are sent back as Discord messages
 *
 * This is a lightweight optional dependency. discord.js is not included
 * in the base extension bundle and must be installed separately.
 */

import type { OutputChannel } from "vscode"
import type { DiscordConfig, TransportMessageHandler } from "./types"
import type { WebviewMessage } from "../../shared/WebviewMessage"

/**
 * Minimum Discord.js types we need. We use dynamic imports so
 * discord.js is not required unless the feature is enabled.
 */
interface DiscordClient {
	on(event: "ready", listener: () => void): void
	on(event: "messageCreate", listener: (message: DiscordMessage) => void): void
	login(token: string): Promise<string>
	destroy(): void
	user: { tag: string; id: string } | null
}

interface DiscordMessage {
	author: { id: string; bot: boolean }
	channel: {
		type: "DM" | "GUILD_TEXT"
		send(content: string): Promise<unknown>
		isDMBased(): boolean
	}
	content: string
	reply(content: string): Promise<unknown>
}

export class DiscordBot {
	private client: DiscordClient | null = null
	private config: DiscordConfig
	private outputChannel: OutputChannel
	private messageHandler: TransportMessageHandler | null = null
	private initialized = false

	constructor(config: DiscordConfig, outputChannel: OutputChannel) {
		this.config = config
		this.outputChannel = outputChannel
	}

	/**
	 * Set the handler for incoming messages from Discord.
	 */
	setMessageHandler(handler: TransportMessageHandler): void {
		this.messageHandler = handler
	}

	/**
	 * Initialize and log in the Discord bot.
	 */
	async start(): Promise<void> {
		if (!this.config.enabled) {
			this.outputChannel.appendLine("[DiscordBot] Discord integration is disabled")
			return
		}

		if (!this.config.botToken) {
			this.outputChannel.appendLine(
				"[DiscordBot] Discord bot token not configured. " +
					"Set zooCode.remoteAccess.discord.botToken in settings.",
			)
			return
		}

		if (!this.config.authorizedUserId) {
			this.outputChannel.appendLine(
				"[DiscordBot] Authorized user ID not configured. " +
					"Set zooCode.remoteAccess.discord.authorizedUserId in settings.",
			)
			return
		}

		try {
			// Dynamic import of discord.js — only loaded when the feature is enabled
			const { Client, GatewayIntentBits, Partials } = await import("discord.js")

			const client: DiscordClient = new Client({
				intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
				partials: [Partials.Channel],
			}) as unknown as DiscordClient

			client.on("ready", () => {
				this.initialized = true
				this.outputChannel.appendLine(`[DiscordBot] Connected as ${client.user?.tag ?? "unknown"}`)
			})

			client.on("messageCreate", async (message) => {
				await this.handleMessage(message)
			})

			await client.login(this.config.botToken)
			this.client = client
		} catch (err) {
			this.outputChannel.appendLine(
				`[DiscordBot] Failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
			)
			this.outputChannel.appendLine("[DiscordBot] Make sure discord.js is installed: pnpm add discord.js")
		}
	}

	/**
	 * Disconnect and clean up the Discord bot.
	 */
	async stop(): Promise<void> {
		if (this.client) {
			try {
				this.client.destroy()
			} catch {
				// Best-effort cleanup
			}
			this.client = null
		}
		this.initialized = false
		this.outputChannel.appendLine("[DiscordBot] Disconnected")
	}

	/**
	 * Send a message back to the authorized user via Discord DM.
	 */
	async sendToUser(content: string): Promise<void> {
		if (!this.client || !this.initialized) return

		try {
			// discord.js fetchUser is not in our minimal type — use any cast
			const discordClient = this.client as unknown as {
				users: { fetch(id: string): Promise<{ send(content: string): Promise<void> }> }
			}
			const user = await discordClient.users.fetch(this.config.authorizedUserId)
			await user.send(content)
		} catch (err) {
			this.outputChannel.appendLine(
				`[DiscordBot] Failed to send DM: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	// ─── Private helpers ────────────────────────────────────────────────

	private async handleMessage(message: DiscordMessage): Promise<void> {
		// Ignore messages from bots (including our own)
		if (message.author.bot) return

		// Only respond to DMs from the authorized user
		if (!message.channel.isDMBased()) return
		if (message.author.id !== this.config.authorizedUserId) {
			this.outputChannel.appendLine(`[DiscordBot] Ignored DM from unauthorized user: ${message.author.id}`)
			return
		}

		// Forward the message to the transport handler
		const webviewMessage = {
			type: "chatResponse",
			text: message.content,
			images: [],
		} as unknown as WebviewMessage

		if (this.messageHandler) {
			try {
				await this.messageHandler({
					message: webviewMessage,
					meta: {
						transport: "discord",
						clientId: message.author.id,
						timestamp: Date.now(),
					},
				})
			} catch (err) {
				this.outputChannel.appendLine(
					`[DiscordBot] Error forwarding message: ${err instanceof Error ? err.message : String(err)}`,
				)
				await message.reply("Sorry, I encountered an error processing your message.")
			}
		}
	}
}

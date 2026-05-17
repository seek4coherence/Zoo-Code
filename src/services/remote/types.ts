/**
 * Remote access types for the Zoo Code extension.
 *
 * These types support two remote communication channels:
 * 1. WebUI - A standalone web interface served over HTTP/WebSocket
 * 2. Discord - A Discord bot for private DM-based agent interaction
 */

import type { WebviewMessage } from "@roo/WebviewMessage"

/**
 * Supported message transport backends.
 */
export type TransportType = "vscode" | "websocket" | "discord"

/**
 * Metadata attached to each incoming message so the message handler
 * knows which transport it arrived on and can route responses accordingly.
 */
export interface TransportMetadata {
	/** Which transport delivered this message */
	transport: TransportType
	/** Unique client identifier (WebSocket connection ID or Discord user ID) */
	clientId: string
	/** When the message was received (epoch ms) */
	timestamp: number
}

/**
 * A message envelope that wraps a WebviewMessage with transport metadata.
 */
export interface TransportMessage {
	/** The original webview message */
	message: WebviewMessage
	/** Transport routing metadata */
	meta: TransportMetadata
}

/**
 * A generic handler for incoming transport messages.
 * The extension host calls this when a message arrives from any transport.
 */
export type TransportMessageHandler = (msg: TransportMessage) => Promise<void>

/**
 * Configuration for the remote WebUI server.
 */
export interface WebUIConfig {
	/** Whether the WebUI server is enabled */
	enabled: boolean
	/** Port to listen on (default: 3000) */
	port: number
	/** Whether to allow remote (non-localhost) connections */
	allowRemote: boolean
	/** Optional password for remote access authentication */
	password?: string
	/** Session token expiry in seconds (default: 3600 = 1 hour) */
	sessionTimeoutSeconds: number
}

/**
 * Configuration for the Discord bot integration.
 */
export interface DiscordConfig {
	/** Whether the Discord bot is enabled */
	enabled: boolean
	/** Discord bot token (from Discord Developer Portal) */
	botToken: string
	/** Authorized Discord user ID (only this user's DMs are processed) */
	authorizedUserId: string
}

/**
 * Remote access configuration container.
 */
export interface RemoteAccessConfig {
	webui: WebUIConfig
	discord: DiscordConfig
}

/**
 * Default WebUI configuration.
 */
export const DEFAULT_WEBUI_CONFIG: WebUIConfig = {
	enabled: false,
	port: 3000,
	allowRemote: false,
	sessionTimeoutSeconds: 3600,
}

/**
 * Default Discord configuration.
 */
export const DEFAULT_DISCORD_CONFIG: DiscordConfig = {
	enabled: false,
	botToken: "",
	authorizedUserId: "",
}

/**
 * Default remote access configuration.
 */
export const DEFAULT_REMOTE_ACCESS_CONFIG: RemoteAccessConfig = {
	webui: DEFAULT_WEBUI_CONFIG,
	discord: DEFAULT_DISCORD_CONFIG,
}

/**
 * VS Code configuration keys for remote access settings.
 */
export const CONFIG_SECTION = "zooCode.remoteAccess"
export const CONFIG_KEYS = {
	webuiEnabled: `${CONFIG_SECTION}.webui.enabled`,
	webuiPort: `${CONFIG_SECTION}.webui.port`,
	webuiAllowRemote: `${CONFIG_SECTION}.webui.allowRemote`,
	webuiPassword: `${CONFIG_SECTION}.webui.password`,
	discordEnabled: `${CONFIG_SECTION}.discord.enabled`,
	discordBotToken: `${CONFIG_SECTION}.discord.botToken`,
	discordAuthorizedUserId: `${CONFIG_SECTION}.discord.authorizedUserId`,
} as const

/**
 * Auth token claims for WebUI sessions.
 */
export interface SessionToken {
	/** Session ID (UUID) */
	sessionId: string
	/** Client identifier */
	clientId: string
	/** When the session was created (epoch seconds) */
	iat: number
	/** When the session expires (epoch seconds) */
	exp: number
}

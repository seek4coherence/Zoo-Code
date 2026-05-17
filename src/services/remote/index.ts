/**
 * Remote access services for Zoo Code.
 *
 * Provides two complementary remote communication channels:
 * - WebUI: Standalone browser-based interface over HTTP/WebSocket
 * - Discord: Private DM-based agent interaction via Discord bot
 *
 * Usage in extension.ts:
 * ```ts
 * import { MessageBridge } from "./services/remote"
 * const bridge = new MessageBridge(context, outputChannel)
 * await bridge.initialize(provider.handleWebviewMessage)
 * ```
 */

export { MessageBridge } from "./MessageBridge"
export { RemoteWebServer } from "./RemoteWebServer"
export { DiscordBot } from "./DiscordBot"
export * from "./types"

const ChannelAdapter = require("./channelAdapter");

class DiscordAdapter extends ChannelAdapter {
  constructor(client) {
    super("discord");
    if (!client) throw new TypeError("DiscordAdapter requires a discord client");
    this.client = client;
  }

  onMessage(handler) {
    this.client.on("messageCreate", handler);
  }

  onReady(handler) {
    this.client.once("ready", handler);
  }

  login(token) {
    return this.client.login(token);
  }

  reply(message, content) {
    return message.reply(content);
  }

  send(channel, content) {
    return channel.send(content);
  }

  async resolveWarRoom(fallbackChannel) {
    const channelId = process.env.AI_WAR_ROOM_CHANNEL_ID;
    if (!channelId) return fallbackChannel;
    try {
      return (await this.client.channels.fetch(channelId)) || fallbackChannel;
    } catch (_) {
      return fallbackChannel;
    }
  }
}

module.exports = DiscordAdapter;

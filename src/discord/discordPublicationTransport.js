function createDiscordPublicationTransport(client) {
  return {
    async send({ channelId, content }) {
      const channel = await client.channels.fetch(channelId);
      if (!channel || typeof channel.send !== "function") throw new Error(`Discord channel ${channelId} is not sendable`);
      return channel.send({ content, allowedMentions: { parse: [] } });
    },
    async findByMarker({ channelId, marker, authorId }) {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.messages || typeof channel.messages.fetch !== "function") return [];
      const matches = [];
      let before;
      for (let page = 0; page < 10; page += 1) {
        const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        const values = [...messages.values()];
        matches.push(...values
          .filter((message) => String(message.author && message.author.id) === String(authorId))
          .filter((message) => String(message.content || "").includes(`[${marker}]`))
          .map((message) => ({ id: message.id })));
        if (matches.length > 0 || values.length < 100) break;
        before = values[values.length - 1].id;
      }
      return matches;
    },
  };
}

module.exports = { createDiscordPublicationTransport };

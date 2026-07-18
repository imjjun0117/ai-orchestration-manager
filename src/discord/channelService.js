/**
 * war-room 채널을 결정합니다.
 * AI_WAR_ROOM_CHANNEL_ID가 .env에 설정되어 있고 조회 가능하면 그 채널을 사용하고,
 * 없거나 조회에 실패하면 명령이 입력된 채널(fallbackChannel)을 그대로 사용한다.
 * (전용 채널 설정 없이도 바로 동작하도록 하기 위함)
 * @param {import("discord.js").Client} client
 * @param {import("discord.js").TextBasedChannel} fallbackChannel
 */
async function getWarRoomChannel(client, fallbackChannel) {
  const channelId = process.env.AI_WAR_ROOM_CHANNEL_ID;
  if (!channelId) {
    return fallbackChannel;
  }
  try {
    const channel = await client.channels.fetch(channelId);
    return channel || fallbackChannel;
  } catch (err) {
    return fallbackChannel;
  }
}

module.exports = {
  getWarRoomChannel,
};

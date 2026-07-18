class ChannelAdapter {
  constructor(type) {
    this.type = String(type || "unknown");
  }

  onMessage() {
    throw new Error(`${this.type} adapter must implement onMessage`);
  }

  onReady() {
    throw new Error(`${this.type} adapter must implement onReady`);
  }

  login() {
    throw new Error(`${this.type} adapter must implement login`);
  }
}

module.exports = ChannelAdapter;

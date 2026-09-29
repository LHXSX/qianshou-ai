/** Fixed package-owned worklet code, embedded in the shipped Client artifact. */
export const CAPTURE_PROCESSOR = 'qianshou-voice-capture'

/** Audio-thread batching avoids main-thread audio processing and bounds transfer size. */
export const CAPTURE_WORKLET_SOURCE = `
class QianshouVoiceCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.maximum = options.processorOptions.maximum;
    this.count = 0;
    this.frame = new Float32Array(2048);
    this.offset = 0;
    this.finished = false;
    this.limited = false;
    this.port.onmessage = (event) => {
      if (event.data !== 'finish' || this.finished) return;
      this.finished = true;
      this.flush();
      this.port.postMessage('done');
    };
  }
  flush() {
    if (this.offset === 0) return;
    const frame = this.frame.slice(0, this.offset);
    this.offset = 0;
    this.port.postMessage(frame, [frame.buffer]);
  }
  process(inputs) {
    if (this.finished) return false;
    const input = inputs[0]?.[0];
    if (input === undefined || this.limited) return true;
    for (let i = 0; i < input.length && this.count < this.maximum; i++) {
      this.frame[this.offset++] = input[i];
      this.count++;
      if (this.offset === this.frame.length) this.flush();
    }
    if (this.count >= this.maximum) {
      this.limited = true;
      this.flush();
      this.port.postMessage('limit');
    }
    return true;
  }
}
registerProcessor('${CAPTURE_PROCESSOR}', QianshouVoiceCapture);
`

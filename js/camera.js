// Fotocamera del dispositivo (solo se l'utente la attiva e il browser lo consente).
// Fornisce fotogrammi ridotti agli analizzatori (movimento per gli incidenti, colori per i semafori).
// Nulla viene registrato né inviato: l'elaborazione avviene tutta sul dispositivo.

import { bus as defaultBus } from './util.js';

export class CameraService {
  constructor({ video, mediaDevices = globalThis.navigator?.mediaDevices, bus = defaultBus, fps = 10 } = {}) {
    this.video = video; this.md = mediaDevices; this.bus = bus; this.fps = fps;
    this.stream = null;
    this.timer = null;
    this.subscribers = new Set();
    this.canvasSmall = null; this.canvasBig = null;
    this.needBig = false;
    this.lastError = '';
  }

  get supported() { return !!this.md?.getUserMedia; }
  get active() { return !!this.stream; }

  subscribe(fn) { this.subscribers.add(fn); return () => this.subscribers.delete(fn); }

  async start({ facing = 'environment' } = {}) {
    if (!this.supported) throw new Error('fotocamera non supportata');
    if (this.stream) return;
    try {
      this.stream = await this.md.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15 } },
        audio: false,
      });
    } catch (e) {
      this.lastError = e?.name || 'errore';
      throw e;
    }
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play().catch(() => {});
    this.canvasSmall = Object.assign(document.createElement('canvas'), { width: 64, height: 36 });
    this.canvasBig = Object.assign(document.createElement('canvas'), { width: 320, height: 180 });
    this.timer = setInterval(() => this._tick(), 1000 / this.fps);
    this.bus.emit('camera:state', { active: true });
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.bus.emit('camera:state', { active: false });
  }

  _grab(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  _tick() {
    if (!this.video || this.video.readyState < 2) return;
    const frame = { ts: Date.now(), small: this._grab(this.canvasSmall), big: this.needBig ? this._grab(this.canvasBig) : null };
    for (const fn of this.subscribers) { try { fn(frame); } catch (e) { console.error('[camera]', e); } }
  }
}

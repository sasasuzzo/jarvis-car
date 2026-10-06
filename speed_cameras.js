// Autovelox: avviso anticipato (una volta per autovelox) e, se il limite è noto,
// segnalazione se si sta superando. Dati: OpenStreetMap (posizioni fisse note).
// Non rileva controlli mobili né segnali radar: nessun "radar detector".

import { Persona } from './persona.js';
import { Priority } from './voice.js';
import { clamp, KMH } from './util.js';

export class SpeedCameraMonitor {
  constructor({ store, voice, navigator, now = () => Date.now() }) {
    this.store = store; this.voice = voice; this.navigator = navigator; this.now = now;
    this.lastSpeedWarn = 0;
    this.nextCamera = null;
  }

  /** Da chiamare a ogni fix GPS. */
  onFix(fix) {
    const speedMs = fix.speed ?? 0;
    const v = Math.max(speedMs, 8);
    const far = clamp(v * 32, 400, 1000);   // ~30 s prima
    const near = clamp(v * 10, 150, 320);   // ~10 s prima

    let list;
    if (this.navigator.active && this.navigator.progress) {
      list = this.store.ahead('camera', this.navigator.progress.alongM, 1500);
    } else {
      this.store.refreshAround(fix);
      list = this.store.cone('camera', fix, 1200);
    }
    this.nextCamera = list[0] ?? null;
    if (!list.length) return;

    const kmh = speedMs * KMH;
    for (const cam of list) {
      const d = cam.distM;
      if (d <= far) {
        this.voice.announce({
          key: `cam:${cam.id}:far`,
          text: Persona.cameraAhead(d, cam.maxspeed),
          priority: Priority.IMPORTANT,
          ttlMs: 9000, cooldownMs: 30 * 60000, source: 'speed_camera',
          meta: { id: cam.id, distM: d },
        });
      }
      // vicino e velocità sopra il limite noto: un secondo avviso, solo se serve
      if (d <= near && cam.maxspeed && kmh > cam.maxspeed + 5 && this.now() - this.lastSpeedWarn > 60000) {
        this.lastSpeedWarn = this.now();
        this.voice.announce({
          key: `cam:${cam.id}:over`,
          text: Persona.speedOverLimit(cam.maxspeed, Math.round(kmh)),
          priority: Priority.CRITICAL,
          ttlMs: 6000, cooldownMs: 5 * 60000, source: 'speed_camera',
        });
      }
    }
  }
}

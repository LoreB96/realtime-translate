import { contextBridge, ipcRenderer } from 'electron';
import {
  OFFSCREEN_IPC,
  type LevelReport,
  type OffscreenPreloadBridge,
  type StreamEvent,
} from '../shared/offscreenContract';

const bridge: OffscreenPreloadBridge = {
  onPushPlayback: (handler: (streamId: string, base64: string) => void): void => {
    ipcRenderer.on(
      OFFSCREEN_IPC.PushPlayback,
      (_e, payload: { streamId: string; base64: string }) =>
        handler(payload.streamId, payload.base64),
    );
  },
  sendPcm: (streamId: string, base64: string): void => {
    ipcRenderer.send(OFFSCREEN_IPC.Pcm, { streamId, base64 });
  },
  /** Periodic input level (no audio content). Main validates with isLevelReport. */
  sendLevel: (report: LevelReport): void => {
    ipcRenderer.send(OFFSCREEN_IPC.Level, report);
  },
  /** Track ended / context suspended / resumed. Main validates with isStreamEvent. */
  sendStreamEvent: (e: StreamEvent): void => {
    ipcRenderer.send(OFFSCREEN_IPC.StreamEvent, e);
  },
  /** Audio device list changed (debounced in the renderer). */
  sendDeviceChange: (): void => {
    ipcRenderer.send(OFFSCREEN_IPC.DeviceChange);
  },
};

declare global {
  interface Window {
    offscreenBridge: OffscreenPreloadBridge;
  }
}

contextBridge.exposeInMainWorld('offscreenBridge', bridge);

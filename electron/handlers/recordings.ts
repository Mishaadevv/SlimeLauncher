import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc.js';
import type { HandlerDeps } from './types.js';

export function registerRecordingHandlers(deps: HandlerDeps) {
  ipcMain.handle(IPC.REC_LIST, () => deps.recorder.list());
  ipcMain.handle(IPC.REC_DELETE, (_e, id: string) => deps.recorder.delete(id));
  ipcMain.handle(IPC.REC_OPEN_FOLDER, () => deps.recorder.openFolder());
  ipcMain.handle(IPC.REC_START, () => deps.recorder.startRecording({}));
  ipcMain.handle(IPC.REC_STOP, () => deps.recorder.stopRecording());
  ipcMain.handle(IPC.REC_STATUS, () => deps.recorder.getStatus());
  ipcMain.handle(IPC.REC_FFMPEG_STATUS, () => deps.recorder.ffmpegStatus());
  ipcMain.handle(IPC.REC_INSTALL_FFMPEG, () => deps.recorder.installFfmpeg());
  ipcMain.handle(IPC.REC_AUDIO_DEVICES, () => deps.recorder.audioDevices());
  ipcMain.handle(IPC.REC_SHOT_CAPTURE, () => deps.recorder.captureScreenshot({}));
  ipcMain.handle(IPC.REC_SHOT_LIST, () => deps.recorder.screenshots());
  ipcMain.handle(IPC.REC_SHOT_DELETE, (_e, id: string) => deps.recorder.deleteScreenshot(id));
  ipcMain.handle(IPC.REC_STATS, () => deps.recorder.stats());
}

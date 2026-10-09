import type { Scene } from "@babylonjs/core";
import type { ImageUploadLimits } from "@foss-earth/renderer/babylon";
import { createCubeUploadAdapter } from "@foss-earth/cubemap/babylon";
import { createEquirectUploadAdapter } from "@foss-earth/equirectangular/babylon";
import { requiredImageHost } from "./browserHost.js";
export type { UploadedImageTexture as PanoramaGpuTexture } from "@foss-earth/renderer/babylon";

/** Retained control call shape, public adapters and one supplied session. */
export function createPanoramaUploader(scene: Scene, limits: ImageUploadLimits, requestRender: () => void) {
  const host = requiredImageHost();
  const uploader = host.controlUploader(scene, limits, requestRender);
  return {
    uploadCube: createCubeUploadAdapter(uploader, host.broker, host.scope),
    uploadEquirect: createEquirectUploadAdapter(uploader, host.broker, host.scope),
    pump: () => uploader.pump(), busy: () => uploader.busy(), stats: () => uploader.stats(),
    cancelAll: (reason: string, options?: { deviceLost?: boolean }) => uploader.cancelAll(reason, options),
  };
}

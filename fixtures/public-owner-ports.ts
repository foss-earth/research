import type { ResearchBrowserHost, ResearchMapHost, ResearchImageHost } from "../scripts/lib/browserHost.js";
import { createPanoramaUploader } from "../scripts/lib/controlUploader.js";
import type { CameraControllerPorts, RasterTilesRuntimeOptions } from "@foss-earth/engine/babylon";
import type { SettingsRegistry } from "@foss-earth/ui/settings";
import type { ImageTextureUploader, RendererBootstrapHost } from "@foss-earth/renderer/babylon";
import type { ImageSessionBroker, ImageOperationScope } from "@foss-earth/images";
/** Compile from exact installed archives after a grant; no device/frame/input is constructed here. */
export function suppliedMapHost(camera: CameraControllerPorts, settings: SettingsRegistry, renderer: RendererBootstrapHost, raster: Omit<RasterTilesRuntimeOptions, "scene" | "source" | "settings">): ResearchMapHost {
  return { camera, settings, renderer, raster };
}
export function suppliedImageHost(broker: ImageSessionBroker, scope: ImageOperationScope, uploader: ImageTextureUploader): ResearchImageHost {
  return { broker, scope, controlUploader: () => uploader };
}
export function suppliedBrowserHost(map: ResearchMapHost, images: ResearchImageHost): ResearchBrowserHost { return { map, images }; }
export const retainedControlAdapter = createPanoramaUploader;

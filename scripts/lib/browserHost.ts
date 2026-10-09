import type { CameraControllerPorts, RasterTilesRuntimeOptions } from "@foss-earth/engine/babylon";
import type { SettingsRegistry } from "@foss-earth/ui/settings";
import type { RendererBootstrapHost, ImageTextureUploader, ImageUploadLimits } from "@foss-earth/renderer/babylon";
import type { Scene } from "@babylonjs/core";
import type { ImageSessionBroker, ImageOperationScope } from "@foss-earth/images";

/** Required experiment composition; no app singleton or copied catalogue. */
export interface ResearchMapHost {
  camera: CameraControllerPorts;
  settings: SettingsRegistry;
  renderer: RendererBootstrapHost;
  raster: Omit<RasterTilesRuntimeOptions, "scene" | "source" | "settings">;
}
export interface ResearchImageHost {
  broker: ImageSessionBroker;
  scope: ImageOperationScope;
  /** Return the existing shared queue for this scene/policy/frame authority; do not create a second queue. */
  controlUploader(scene: Scene, limits: ImageUploadLimits, requestRender: () => void): ImageTextureUploader;
}
export interface ResearchBrowserHost { map?: ResearchMapHost; images?: ResearchImageHost }
/** A harness binds this before loading a benchmark bundle; nothing is inferred. */
export function requiredResearchHost(): ResearchBrowserHost {
  const host = (globalThis as typeof globalThis & { FOSS_EARTH_RESEARCH_HOST?: ResearchBrowserHost }).FOSS_EARTH_RESEARCH_HOST;
  if (!host) throw new Error("Pending research host composition: supply FOSS_EARTH_RESEARCH_HOST using exact installed public owner contracts. See tools-manifest.json.");
  return host;
}
export function requiredMapHost(): ResearchMapHost {
  const host = requiredResearchHost().map;
  if (!host) throw new Error("Pending map experiment host: explicit settings catalogue, camera/clock, renderer and raster acquisition/device ports are required.");
  return host;
}
export function requiredImageHost(): ResearchImageHost {
  const host = requiredResearchHost().images;
  if (!host) throw new Error("Pending image experiment host: supply the one broker/scope and canvas ports; no private session budget is constructed.");
  return host;
}

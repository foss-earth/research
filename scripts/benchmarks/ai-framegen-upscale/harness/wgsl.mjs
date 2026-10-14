/**
 * WGSL passes of the ai-framegen-upscale harness (DESIGN.md section 8) and the
 * JavaScript reference of the input conversion. Plain ESM; importing it has
 * no side effects and touches no browser global, so node can import
 * modelInputFromRgba8 for the fixture test.
 *
 *   pack       compute  rgba8unorm texture -> NCHW float32 tensor (RGB, u8/255, zero pad right/bottom)
 *   unpack     compute  NCHW float32 tensor -> rgba8unorm storage texture of the valid size
 *                       (top-left crop, clamp to [0, 1]; the store converts to unorm8)
 *   present    render   texture -> canvas at 1:1 (texel fetch, i.e. nearest), fullscreen triangle
 *   blend      compute  (A + B) / 2 -> rgba8unorm storage texture
 *   bilinear   render   low texture -> output texture through a linear sampler (the "ordinary
 *                       reduced-resolution scaling" control; pixel centres as align_corners=False)
 *   panorama   render   equirect texture + camera -> rgba8unorm target; `taps` > 1 averages that many
 *                       jittered samples per pixel (synthetic load for the break-even sweep)
 *   marker     compute  one 1x1x1 workgroup, used as a timestamp bracket around the model stage
 *
 * Every pass takes optional `timestampWrites`. Bind groups and uniform buffers
 * are made once per binding (createKernels(...).pack({...}) etc.), so encoding
 * a frame allocates nothing.
 */

/**
 * The page's model input: NCHW float32 [1, 3, paddedHeight, paddedWidth] from
 * RGBA u8 rows (alpha ignored), value Math.fround(v / 255) (equal to
 * float32(v) / float32(255) for every byte), zero padding right and bottom.
 * Must reproduce export/common.py to_model_input byte for byte.
 */
export function modelInputFromRgba8(rgba, width, height, paddedWidth, paddedHeight) {
  if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) || rgba.length !== width * height * 4) {
    throw new Error(`expected ${width}x${height} RGBA bytes, got ${rgba?.length}`);
  }
  if (!(paddedWidth >= width && paddedHeight >= height)) throw new Error(`padded size ${paddedWidth}x${paddedHeight} is smaller than ${width}x${height}`);
  const plane = paddedWidth * paddedHeight;
  const out = new Float32Array(3 * plane);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4, to = y * paddedWidth + x;
      out[to] = Math.fround(rgba[from] / 255);
      out[plane + to] = Math.fround(rgba[from + 1] / 255);
      out[2 * plane + to] = Math.fround(rgba[from + 2] / 255);
    }
  }
  return out;
}

const FULLSCREEN = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

export const SHADERS = {
  pack: /* wgsl */ `
struct Dims { validWidth: u32, validHeight: u32, paddedWidth: u32, paddedHeight: u32 }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> tensor: array<f32>;
@group(0) @binding(2) var<uniform> dims: Dims;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= dims.paddedWidth || id.y >= dims.paddedHeight) { return; }
  var color = vec4f(0.0);
  if (id.x < dims.validWidth && id.y < dims.validHeight) { color = textureLoad(source, id.xy, 0); }
  let plane = dims.paddedWidth * dims.paddedHeight;
  let index = id.y * dims.paddedWidth + id.x;
  tensor[index] = color.r;
  tensor[plane + index] = color.g;
  tensor[2u * plane + index] = color.b;
}`,
  unpack: /* wgsl */ `
struct Dims { validWidth: u32, validHeight: u32, tensorWidth: u32, tensorHeight: u32 }
@group(0) @binding(0) var<storage, read> tensor: array<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> dims: Dims;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= dims.validWidth || id.y >= dims.validHeight) { return; }
  let plane = dims.tensorWidth * dims.tensorHeight;
  let index = id.y * dims.tensorWidth + id.x;
  let rgb = clamp(vec3f(tensor[index], tensor[plane + index], tensor[2u * plane + index]), vec3f(0.0), vec3f(1.0));
  textureStore(destination, id.xy, vec4f(rgb, 1.0));
}`,
  present: /* wgsl */ `${FULLSCREEN}
@group(0) @binding(0) var source: texture_2d<f32>;
@fragment fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return vec4f(textureLoad(source, vec2u(position.xy), 0).rgb, 1.0);
}`,
  blend: /* wgsl */ `
@group(0) @binding(0) var first: texture_2d<f32>;
@group(0) @binding(1) var second: texture_2d<f32>;
@group(0) @binding(2) var destination: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(destination);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let mixed = 0.5 * (textureLoad(first, id.xy, 0).rgb + textureLoad(second, id.xy, 0).rgb);
  textureStore(destination, id.xy, vec4f(mixed, 1.0));
}`,
  bilinear: /* wgsl */ `${FULLSCREEN}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> outputSize: vec2f;
@fragment fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return vec4f(textureSampleLevel(source, linearSampler, position.xy / outputSize, 0.0).rgb, 1.0);
}`,
  // Camera convention of the replay renderer (export/replay.py, spherical lib/views.mjs):
  // forward = [cp sy, cp cy, sp], right = [cy, -sy, 0], up = [-sy sp, -cy sp, cp];
  // u = 0.5 + atan2(x, y) / 2 pi, v = 0.5 - asin(z) / pi.
  panorama: /* wgsl */ `${FULLSCREEN}
struct Camera { yaw: f32, pitch: f32, tanHalfFovY: f32, aspect: f32, width: f32, height: f32, taps: u32, pad: u32 }
@group(0) @binding(0) var equirect: texture_2d<f32>;
@group(0) @binding(1) var wrapSampler: sampler;
@group(0) @binding(2) var<uniform> camera: Camera;
const PI = 3.14159265358979;
fn lookup(pixel: vec2f) -> vec3f {
  let sy = sin(camera.yaw); let cy = cos(camera.yaw); let sp = sin(camera.pitch); let cp = cos(camera.pitch);
  let forward = vec3f(cp * sy, cp * cy, sp);
  let right = vec3f(cy, -sy, 0.0);
  let up = vec3f(-sy * sp, -cy * sp, cp);
  let ndc = vec2f(2.0 * pixel.x / camera.width - 1.0, 1.0 - 2.0 * pixel.y / camera.height);
  let ray = normalize(forward + right * (ndc.x * camera.tanHalfFovY * camera.aspect) + up * (ndc.y * camera.tanHalfFovY));
  let uv = vec2f(0.5 + atan2(ray.x, ray.y) / (2.0 * PI), 0.5 - asin(clamp(ray.z, -1.0, 1.0)) / PI);
  return textureSampleLevel(equirect, wrapSampler, uv, 0.0).rgb;
}
@fragment fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  if (camera.taps <= 1u) { return vec4f(lookup(position.xy), 1.0); }
  var sum = vec3f(0.0);
  for (var tap = 0u; tap < camera.taps; tap++) {
    // R2 low-discrepancy offsets inside the pixel.
    let jitter = fract(vec2f(0.7548776662, 0.5698402910) * f32(tap)) - 0.5;
    sum += lookup(position.xy + jitter);
  }
  return vec4f(sum / f32(camera.taps), 1.0);
}`,
  marker: /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> sink: array<u32>;
@compute @workgroup_size(1)
fn main() { sink[0] = sink[0] + 1u; }`,
};

const ceil = (value, step) => Math.ceil(value / step);

export function createRgbaTexture(device, width, height, { storage = false, render = false, label = "rgba8" } = {}) {
  let usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
  if (storage) usage |= GPUTextureUsage.STORAGE_BINDING;
  if (render) usage |= GPUTextureUsage.RENDER_ATTACHMENT;
  return device.createTexture({ label, size: [width, height], format: "rgba8unorm", usage });
}

/** A float32 tensor buffer usable as an ORT GPU tensor (STORAGE | COPY_SRC | COPY_DST). */
export function createTensorBuffer(device, dims, label = "tensor") {
  const elements = dims.reduce((product, value) => product * value, 1);
  return device.createBuffer({ label, size: 4 * elements, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
}

/** Copies `size` bytes of `buffer` into a temporary MAP_READ buffer and returns them (outside any timing). */
export async function readBuffer(device, buffer, size = buffer.size) {
  const staging = device.createBuffer({ label: "readback", size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    return staging.getMappedRange().slice(0);
  } finally {
    staging.destroy();
  }
}

/** Reads an rgba8unorm texture back as tightly packed RGBA rows (rows padded to 256 bytes on the GPU side). */
export async function readTexture(device, texture, width, height) {
  const bytesPerRow = ceil(width * 4, 256) * 256;
  const staging = device.createBuffer({ label: "readback-texture", size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow, rowsPerImage: height }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(staging.getMappedRange());
    const out = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++) out.set(padded.subarray(row * bytesPerRow, row * bytesPerRow + width * 4), row * width * 4);
    return out;
  } finally {
    staging.destroy();
  }
}

/** Uploads tightly packed RGBA rows into an rgba8unorm texture. */
export function writeRgbaTexture(device, texture, rgba, width, height) {
  device.queue.writeTexture({ texture }, rgba, { bytesPerRow: width * 4, rowsPerImage: height }, [width, height]);
}

/**
 * Compiles the passes for `device` (lazily, once) and returns binding
 * factories. `canvasFormat` is the presentation format (bgra8unorm here).
 */
export function createKernels(device, { canvasFormat = "bgra8unorm" } = {}) {
  const cache = new Map();
  const module = name => {
    if (!cache.has(name)) cache.set(name, device.createShaderModule({ label: name, code: SHADERS[name] }));
    return cache.get(name);
  };
  const pipelines = new Map();
  const compute = name => {
    if (!pipelines.has(name)) pipelines.set(name, device.createComputePipeline({ label: name, layout: "auto", compute: { module: module(name), entryPoint: "main" } }));
    return pipelines.get(name);
  };
  const render = (name, format) => {
    const key = `${name}:${format}`;
    if (!pipelines.has(key)) {
      pipelines.set(key, device.createRenderPipeline({
        label: key, layout: "auto",
        vertex: { module: module(name), entryPoint: "vs" },
        fragment: { module: module(name), entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      }));
    }
    return pipelines.get(key);
  };
  const uniform = (label, data) => {
    const buffer = device.createBuffer({ label, size: Math.max(16, ceil(data.byteLength, 16) * 16), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };
  const computePass = (encoder, pipeline, bindGroup, x, y, timestampWrites, label) => {
    const pass = encoder.beginComputePass(timestampWrites ? { label, timestampWrites } : { label });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(x, y);
    pass.end();
  };
  const renderPass = (encoder, pipeline, bindGroup, view, timestampWrites, label) => {
    const pass = encoder.beginRenderPass({
      label, colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
      ...(timestampWrites ? { timestampWrites } : {}),
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  };
  let linear = null, wrap = null;
  const linearSampler = () => (linear ??= device.createSampler({ label: "linear-clamp", magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }));
  const wrapSampler = () => (wrap ??= device.createSampler({ label: "linear-wrap-u", magFilter: "linear", minFilter: "linear", addressModeU: "repeat", addressModeV: "clamp-to-edge" }));

  return {
    canvasFormat,
    /** texture (valid size) -> tensor buffer [1, 3, paddedHeight, paddedWidth]. */
    pack({ texture, buffer, validWidth, validHeight, paddedWidth, paddedHeight }) {
      const pipeline = compute("pack");
      const dims = uniform("pack-dims", new Uint32Array([validWidth, validHeight, paddedWidth, paddedHeight]));
      const bindGroup = device.createBindGroup({ label: "pack", layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: texture.createView() }, { binding: 1, resource: { buffer } }, { binding: 2, resource: { buffer: dims } },
      ] });
      return { encode: (encoder, timestampWrites) => computePass(encoder, pipeline, bindGroup, ceil(paddedWidth, 16), ceil(paddedHeight, 16), timestampWrites, "pack"), destroy: () => dims.destroy() };
    },
    /** tensor buffer [1, 3, tensorHeight, tensorWidth] -> storage texture (valid size, top-left crop). */
    unpack({ buffer, texture, validWidth, validHeight, tensorWidth, tensorHeight }) {
      const pipeline = compute("unpack");
      const dims = uniform("unpack-dims", new Uint32Array([validWidth, validHeight, tensorWidth, tensorHeight]));
      const bindGroup = device.createBindGroup({ label: "unpack", layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer } }, { binding: 1, resource: texture.createView() }, { binding: 2, resource: { buffer: dims } },
      ] });
      return { encode: (encoder, timestampWrites) => computePass(encoder, pipeline, bindGroup, ceil(validWidth, 16), ceil(validHeight, 16), timestampWrites, "unpack"), destroy: () => dims.destroy() };
    },
    /** texture -> a render target view of the same size (the canvas texture each frame). */
    present({ texture, format = canvasFormat }) {
      const pipeline = render("present", format);
      const bindGroup = device.createBindGroup({ label: "present", layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }] });
      return { encode: (encoder, view, timestampWrites) => renderPass(encoder, pipeline, bindGroup, view, timestampWrites, "present"), destroy() {} };
    },
    /** (first + second) / 2 -> target storage texture. */
    blend({ first, second, target }) {
      const pipeline = compute("blend");
      const bindGroup = device.createBindGroup({ label: "blend", layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: first.createView() }, { binding: 1, resource: second.createView() }, { binding: 2, resource: target.createView() },
      ] });
      return { encode: (encoder, timestampWrites) => computePass(encoder, pipeline, bindGroup, ceil(target.width, 16), ceil(target.height, 16), timestampWrites, "blend"), destroy() {} };
    },
    /** source (low) -> target texture (render attachment) through a linear sampler. */
    bilinear({ source, target }) {
      const pipeline = render("bilinear", target.format);
      const size = uniform("bilinear-size", new Float32Array([target.width, target.height]));
      const bindGroup = device.createBindGroup({ label: "bilinear", layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: source.createView() }, { binding: 1, resource: linearSampler() }, { binding: 2, resource: { buffer: size } },
      ] });
      const view = target.createView();
      return { encode: (encoder, timestampWrites) => renderPass(encoder, pipeline, bindGroup, view, timestampWrites, "bilinear"), destroy: () => size.destroy() };
    },
    /** equirect texture -> target texture; setCamera(yawDegrees, pitchDegrees) before encode. */
    panorama({ equirect, target, fovYDegrees = 75, taps = 1 }) {
      const pipeline = render("panorama", target.format);
      const data = new ArrayBuffer(32), floats = new Float32Array(data), words = new Uint32Array(data);
      const tanHalf = Math.tan((fovYDegrees * Math.PI) / 360);
      const cameraBuffer = device.createBuffer({ label: "panorama-camera", size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const bindGroup = device.createBindGroup({ label: "panorama", layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: equirect.createView() }, { binding: 1, resource: wrapSampler() }, { binding: 2, resource: { buffer: cameraBuffer } },
      ] });
      const view = target.createView();
      const setCamera = (yawDegrees, pitchDegrees = 0) => {
        floats.set([(yawDegrees * Math.PI) / 180, (pitchDegrees * Math.PI) / 180, tanHalf, target.width / target.height, target.width, target.height]);
        words[6] = Math.max(1, taps | 0);
        device.queue.writeBuffer(cameraBuffer, 0, data);
      };
      setCamera(0, 0);
      return { setCamera, encode: (encoder, timestampWrites) => renderPass(encoder, pipeline, bindGroup, view, timestampWrites, "panorama"), destroy: () => cameraBuffer.destroy() };
    },
    /** A one-workgroup dispatch whose pass timestamps bracket other work. */
    marker() {
      const pipeline = compute("marker");
      const sink = device.createBuffer({ label: "marker-sink", size: 16, usage: GPUBufferUsage.STORAGE });
      const bindGroup = device.createBindGroup({ label: "marker", layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: sink } }] });
      return { encode: (encoder, timestampWrites) => computePass(encoder, pipeline, bindGroup, 1, 1, timestampWrites, "marker"), destroy: () => sink.destroy() };
    },
  };
}

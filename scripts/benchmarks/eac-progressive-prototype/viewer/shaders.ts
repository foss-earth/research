/**
 * The prototype's shaders, in GLSL ES 1.00 for WebGL 1 and 2 (Babylon
 * translates it for WebGL 2) and in WGSL for WebGPU. One display rule for every
 * backend, the one lib/render-cpu.mjs writes out on the CPU:
 *
 *   direction → face and (u, v) → the display table's entry for the cell →
 *   a tile's slot in the atlas and its level, or the bootstrap → one bilinear
 *   tap inside that tile's stored texels.
 *
 * Two ways to get (face, u, v):
 *
 * - **Ray lookup**: one triangle covers the view; each pixel turns its ray into
 *   a face position, with two arctangents for the equi-angular cube.
 * - **Mesh patches**: each face is a grid of triangles placed on the sphere on
 *   the CPU; the pixel is handed its face position. The map is exact only at
 *   the vertices.
 *
 * Textures are plain RGBA8 (not sRGB), filtered bilinearly in their encoded
 * values, with no mipmaps: the level is chosen per tile by the selection.
 * Every tap stays inside one tile's stored texels, so no tap reads a
 * neighbouring slot of the atlas. The table is read with nearest filtering.
 */

const GLSL_SHADE = /* glsl */ `
uniform sampler2D tileAtlas;
uniform sampler2D bootAtlas;
uniform sampler2D displayTable;
// cells per face side, logical tile texels, gutter texels, stored tile texels
uniform vec4 tileLayout;
// atlas width and height in texels, slots per atlas row, faces in the table
uniform vec4 atlasInfo;
// bootstrap face size, gutter, bootstrap atlas width and height
uniform vec4 bootInfo;
uniform float debugLevels;

vec4 levelTint(float level) {
  if (level < 0.5) return vec4(1.0, 0.25, 0.25, 1.0);
  if (level < 1.5) return vec4(1.0, 0.7, 0.2, 1.0);
  if (level < 2.5) return vec4(1.0, 1.0, 0.3, 1.0);
  if (level < 3.5) return vec4(0.3, 1.0, 0.4, 1.0);
  return vec4(0.3, 0.7, 1.0, 1.0);
}

vec4 shade(float face, vec2 uv) {
  uv = clamp(uv, 0.0, 1.0);
  float C = tileLayout.x;
  vec2 cell = min(floor(uv * C), vec2(C - 1.0));
  vec4 entry = texture2D(displayTable, (vec2(face * C + cell.x, cell.y) + 0.5) / vec2(atlasInfo.w * C, C));
  float shown = floor(entry.b * 255.0 + 0.5);
  vec4 colour;
  if (shown < 0.5) {
    vec2 at = vec2(mod(face, 3.0), floor(face / 3.0)) * (bootInfo.x + 2.0 * bootInfo.y) + bootInfo.y + uv * bootInfo.x;
    colour = texture2D(bootAtlas, at / bootInfo.zw);
  } else {
    float n = exp2(shown - 1.0);
    vec2 tile = min(floor(uv * n), vec2(n - 1.0));
    vec2 slot = floor(entry.rg * 255.0 + 0.5);
    vec2 at = slot * tileLayout.w + tileLayout.z + (uv * n - tile) * tileLayout.y;
    colour = texture2D(tileAtlas, at / atlasInfo.xy);
  }
  if (debugLevels > 0.5) {
    vec2 inTile = fract(uv * (shown < 0.5 ? 1.0 : exp2(shown - 1.0)));
    float edge = step(min(min(inTile.x, inTile.y), min(1.0 - inTile.x, 1.0 - inTile.y)), 0.004);
    colour = mix(colour * levelTint(shown), vec4(1.0), edge);
  }
  return vec4(colour.rgb, 1.0);
}`;

/** Face and (u, v) of a direction: faces px nx py ny pz nz with the format's frames; `warp` 1 is equi-angular. */
const GLSL_LOCATE = /* glsl */ `
uniform float warp;
void locate(vec3 d, out float face, out vec2 uv) {
  vec3 a = abs(d);
  vec3 f; vec3 r; vec3 t;
  if (a.x >= a.y && a.x >= a.z) {
    if (d.x > 0.0) { face = 0.0; f = vec3(1.0, 0.0, 0.0); r = vec3(0.0, -1.0, 0.0); } else { face = 1.0; f = vec3(-1.0, 0.0, 0.0); r = vec3(0.0, 1.0, 0.0); }
    t = vec3(0.0, 0.0, 1.0);
  } else if (a.y >= a.z) {
    if (d.y > 0.0) { face = 2.0; f = vec3(0.0, 1.0, 0.0); r = vec3(1.0, 0.0, 0.0); } else { face = 3.0; f = vec3(0.0, -1.0, 0.0); r = vec3(-1.0, 0.0, 0.0); }
    t = vec3(0.0, 0.0, 1.0);
  } else {
    r = vec3(1.0, 0.0, 0.0);
    if (d.z > 0.0) { face = 4.0; f = vec3(0.0, 0.0, 1.0); t = vec3(0.0, -1.0, 0.0); } else { face = 5.0; f = vec3(0.0, 0.0, -1.0); t = vec3(0.0, 1.0, 0.0); }
  }
  vec2 st = vec2(dot(d, r), dot(d, t)) / dot(d, f);
  if (warp > 0.5) st = atan(st) * 1.2732395447351628;
  uv = vec2(st.x + 1.0, 1.0 - st.y) * 0.5;
}`;

const GLSL_RAY_VERTEX = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform vec3 camRight;
uniform vec3 camUp;
uniform vec3 camForward;
varying vec3 vDir;
void main(void) {
  vDir = camForward + position.x * camRight + position.y * camUp;
  gl_Position = vec4(position.xy, 0.5, 1.0);
}`;

const GLSL_RAY_FRAGMENT = /* glsl */ `
precision highp float;
varying vec3 vDir;
${GLSL_SHADE}
${GLSL_LOCATE}
void main(void) {
  float face; vec2 uv;
  locate(normalize(vDir), face, uv);
  gl_FragColor = shade(face, uv);
}`;

const GLSL_MESH_VERTEX = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec2 uv2;
uniform mat4 viewRotProj;
varying vec2 vUv;
varying float vFace;
void main(void) {
  vUv = uv;
  vFace = uv2.x;
  gl_Position = viewRotProj * vec4(position, 1.0);
}`;

const GLSL_MESH_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying float vFace;
${GLSL_SHADE}
void main(void) {
  gl_FragColor = shade(floor(vFace + 0.5), vUv);
}`;

// ─── WGSL ──────────────────────────────────────────────────────────────

const WGSL_SHADE = /* wgsl */ `
var tileAtlas : texture_2d<f32>;
var tileAtlasSampler : sampler;
var bootAtlas : texture_2d<f32>;
var bootAtlasSampler : sampler;
var displayTable : texture_2d<f32>;
var displayTableSampler : sampler;
uniform tileLayout : vec4<f32>;
uniform atlasInfo : vec4<f32>;
uniform bootInfo : vec4<f32>;
uniform debugLevels : f32;

fn levelTint(level : f32) -> vec4<f32> {
  if (level < 0.5) { return vec4<f32>(1.0, 0.25, 0.25, 1.0); }
  if (level < 1.5) { return vec4<f32>(1.0, 0.7, 0.2, 1.0); }
  if (level < 2.5) { return vec4<f32>(1.0, 1.0, 0.3, 1.0); }
  if (level < 3.5) { return vec4<f32>(0.3, 1.0, 0.4, 1.0); }
  return vec4<f32>(0.3, 0.7, 1.0, 1.0);
}

fn shade(face : f32, uvIn : vec2<f32>) -> vec4<f32> {
  let uv = clamp(uvIn, vec2<f32>(0.0), vec2<f32>(1.0));
  let C = uniforms.tileLayout.x;
  let cell = min(floor(uv * C), vec2<f32>(C - 1.0));
  let entry = textureSampleLevel(displayTable, displayTableSampler, (vec2<f32>(face * C + cell.x, cell.y) + 0.5) / vec2<f32>(uniforms.atlasInfo.w * C, C), 0.0);
  let shown = floor(entry.b * 255.0 + 0.5);
  var colour : vec4<f32>;
  if (shown < 0.5) {
    let at = vec2<f32>(face - 3.0 * floor(face / 3.0), floor(face / 3.0)) * (uniforms.bootInfo.x + 2.0 * uniforms.bootInfo.y) + uniforms.bootInfo.y + uv * uniforms.bootInfo.x;
    colour = textureSampleLevel(bootAtlas, bootAtlasSampler, at / uniforms.bootInfo.zw, 0.0);
  } else {
    let n = exp2(shown - 1.0);
    let tile = min(floor(uv * n), vec2<f32>(n - 1.0));
    let slot = floor(entry.rg * 255.0 + 0.5);
    let at = slot * uniforms.tileLayout.w + uniforms.tileLayout.z + (uv * n - tile) * uniforms.tileLayout.y;
    colour = textureSampleLevel(tileAtlas, tileAtlasSampler, at / uniforms.atlasInfo.xy, 0.0);
  }
  if (uniforms.debugLevels > 0.5) {
    let inTile = fract(uv * select(exp2(shown - 1.0), 1.0, shown < 0.5));
    let edge = step(min(min(inTile.x, inTile.y), min(1.0 - inTile.x, 1.0 - inTile.y)), 0.004);
    colour = mix(colour * levelTint(shown), vec4<f32>(1.0), edge);
  }
  return vec4<f32>(colour.rgb, 1.0);
}`;

const WGSL_LOCATE = /* wgsl */ `
uniform warp : f32;
struct Place { face : f32, uv : vec2<f32> };
fn locate(d : vec3<f32>) -> Place {
  let a = abs(d);
  var face : f32; var f : vec3<f32>; var r : vec3<f32>; var t = vec3<f32>(0.0, 0.0, 1.0);
  if (a.x >= a.y && a.x >= a.z) {
    if (d.x > 0.0) { face = 0.0; f = vec3<f32>(1.0, 0.0, 0.0); r = vec3<f32>(0.0, -1.0, 0.0); } else { face = 1.0; f = vec3<f32>(-1.0, 0.0, 0.0); r = vec3<f32>(0.0, 1.0, 0.0); }
  } else if (a.y >= a.z) {
    if (d.y > 0.0) { face = 2.0; f = vec3<f32>(0.0, 1.0, 0.0); r = vec3<f32>(1.0, 0.0, 0.0); } else { face = 3.0; f = vec3<f32>(0.0, -1.0, 0.0); r = vec3<f32>(-1.0, 0.0, 0.0); }
  } else {
    r = vec3<f32>(1.0, 0.0, 0.0);
    if (d.z > 0.0) { face = 4.0; f = vec3<f32>(0.0, 0.0, 1.0); t = vec3<f32>(0.0, -1.0, 0.0); } else { face = 5.0; f = vec3<f32>(0.0, 0.0, -1.0); t = vec3<f32>(0.0, 1.0, 0.0); }
  }
  var st = vec2<f32>(dot(d, r), dot(d, t)) / dot(d, f);
  if (uniforms.warp > 0.5) { st = atan(st) * 1.2732395447351628; }
  return Place(face, vec2<f32>(st.x + 1.0, 1.0 - st.y) * 0.5);
}`;

const WGSL_RAY_VERTEX = /* wgsl */ `
attribute position : vec3<f32>;
uniform camRight : vec3<f32>;
uniform camUp : vec3<f32>;
uniform camForward : vec3<f32>;
varying vDir : vec3<f32>;
@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  vertexOutputs.vDir = uniforms.camForward + vertexInputs.position.x * uniforms.camRight + vertexInputs.position.y * uniforms.camUp;
  vertexOutputs.position = vec4<f32>(vertexInputs.position.xy, 0.5, 1.0);
}`;

const WGSL_RAY_FRAGMENT = /* wgsl */ `
varying vDir : vec3<f32>;
${WGSL_SHADE}
${WGSL_LOCATE}
@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let place = locate(normalize(fragmentInputs.vDir));
  fragmentOutputs.color = shade(place.face, place.uv);
}`;

const WGSL_MESH_VERTEX = /* wgsl */ `
attribute position : vec3<f32>;
attribute uv : vec2<f32>;
attribute uv2 : vec2<f32>;
uniform viewRotProj : mat4x4<f32>;
varying vUv : vec2<f32>;
varying vFace : f32;
@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  vertexOutputs.vUv = vertexInputs.uv;
  vertexOutputs.vFace = vertexInputs.uv2.x;
  vertexOutputs.position = uniforms.viewRotProj * vec4<f32>(vertexInputs.position, 1.0);
}`;

const WGSL_MESH_FRAGMENT = /* wgsl */ `
varying vUv : vec2<f32>;
varying vFace : f32;
${WGSL_SHADE}
@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  fragmentOutputs.color = shade(floor(fragmentInputs.vFace + 0.5), fragmentInputs.vUv);
}`;

// ─── The whole-image control ───────────────────────────────────────────

/**
 * What the current viewer draws inside a panorama, reduced to the image: a
 * cube preview or one equirectangular image, looked up per pixel with the
 * production shader's conventions (src/engine/babylon/panorama: the cube read
 * with (x, z, y), the equirectangular image with its mipmaps). `srgbTexture` is
 * 1 where the production uploader made an sRGB texture (WebGPU), whose samples
 * arrive linear and are encoded again here.
 */
const GLSL_CONTROL_FRAGMENT = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform samplerCube previewCube;
uniform sampler2D wholeImage;
uniform float useWhole;
uniform float srgbTexture;
void main(void) {
  vec3 d = normalize(vDir);
  vec4 colour = useWhole > 0.5
    ? texture2D(wholeImage, vec2(atan(d.x, d.y) / 6.283185307179586 + 0.5, 0.5 - asin(clamp(d.z, -1.0, 1.0)) / 3.141592653589793))
    : textureCube(previewCube, vec3(d.x, d.z, d.y));
  gl_FragColor = vec4(colour.rgb, 1.0);
}`;

const WGSL_CONTROL_FRAGMENT = /* wgsl */ `
varying vDir : vec3<f32>;
var previewCube : texture_cube<f32>;
var previewCubeSampler : sampler;
var wholeImage : texture_2d<f32>;
var wholeImageSampler : sampler;
uniform useWhole : f32;
uniform srgbTexture : f32;
fn encode(c : vec3<f32>) -> vec3<f32> {
  return select(1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3<f32>(0.0031308));
}
@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let d = normalize(fragmentInputs.vDir);
  let uv = vec2<f32>(atan2(d.x, d.y) / 6.283185307179586 + 0.5, 0.5 - asin(clamp(d.z, -1.0, 1.0)) / 3.141592653589793);
  let whole = textureSample(wholeImage, wholeImageSampler, uv);
  let preview = textureSample(previewCube, previewCubeSampler, vec3<f32>(d.x, d.z, d.y));
  var colour = select(preview.rgb, whole.rgb, uniforms.useWhole > 0.5);
  if (uniforms.srgbTexture > 0.5) { colour = encode(colour); }
  fragmentOutputs.color = vec4<f32>(colour, 1.0);
}`;

export interface ShaderSource { vertexSource: string; fragmentSource: string }
export const rayShader = (webGpu: boolean): ShaderSource => (webGpu ? { vertexSource: WGSL_RAY_VERTEX, fragmentSource: WGSL_RAY_FRAGMENT } : { vertexSource: GLSL_RAY_VERTEX, fragmentSource: GLSL_RAY_FRAGMENT });
export const meshShader = (webGpu: boolean): ShaderSource => (webGpu ? { vertexSource: WGSL_MESH_VERTEX, fragmentSource: WGSL_MESH_FRAGMENT } : { vertexSource: GLSL_MESH_VERTEX, fragmentSource: GLSL_MESH_FRAGMENT });
export const controlShader = (webGpu: boolean): ShaderSource => (webGpu ? { vertexSource: WGSL_RAY_VERTEX, fragmentSource: WGSL_CONTROL_FRAGMENT } : { vertexSource: GLSL_RAY_VERTEX, fragmentSource: GLSL_CONTROL_FRAGMENT });

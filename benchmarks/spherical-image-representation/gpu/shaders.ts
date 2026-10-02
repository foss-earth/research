/**
 * Shaders for the GPU microbenchmark, in GLSL ES 1.00 for WebGL 1 and 2
 * (Babylon translates it for WebGL 2) and in WGSL for WebGPU, following the
 * conventions of src/engine/babylon/panorama. Directions are in the image's
 * own frame: X right, Y forward, Z up.
 *
 * Two ways to draw a panorama:
 *
 * - **Ray lookup**: one triangle covers the view; every pixel turns its ray
 *   into a texture position. The cost is per pixel and depends on the map.
 * - **Mesh patches**: the charts are ordinary textured triangles on a sphere
 *   around the camera; the map is evaluated at the vertices, on the CPU, once.
 *
 * No texture has mipmaps, and every lookup is one bilinear sample, so the
 * variants differ only in their arithmetic.
 */

export type LookupKind = "equirect" | "cube" | "eac" | "oct-ea" | "healpix";

// ─── GLSL ──────────────────────────────────────────────────────────────

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
}
`;

const GLSL_PATCH_VERTEX = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 viewRotProj;
varying vec2 vUv;
void main(void) {
  vUv = uv;
  gl_Position = viewRotProj * vec4(position, 1.0);
}
`;

const GLSL_PATCH_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D panoTexture;
varying vec2 vUv;
void main(void) {
  gl_FragColor = texture2D(panoTexture, vUv);
}
`;

const GLSL_LOOKUP: Record<LookupKind, string> = {
  equirect: /* glsl */ `
uniform sampler2D panoTexture;
uniform vec2 chartSize;
vec4 lookup(vec3 d) {
  vec2 uv = vec2(atan(d.x, d.y) / 6.283185307179586 + 0.5, 0.5 - asin(clamp(d.z, -1.0, 1.0)) / 3.141592653589793);
  return texture2D(panoTexture, (uv * chartSize + 1.0) / (chartSize + 2.0));
}`,
  cube: /* glsl */ `
uniform samplerCube panoCube;
vec4 lookup(vec3 d) {
  return textureCube(panoCube, vec3(d.x, d.z, d.y));
}`,
  eac: /* glsl */ `
uniform samplerCube panoCube;
vec4 lookup(vec3 d) {
  vec3 g = vec3(d.x, d.z, d.y);
  vec3 a = abs(g);
  // On the major axis atan(±1)·4/π is ±1, so the face is unchanged and the other two axes are warped.
  return textureCube(panoCube, atan(g / max(a.x, max(a.y, a.z))) * 1.2732395447351628);
}`,
  "oct-ea": /* glsl */ `
uniform sampler2D panoTexture;
uniform vec2 chartSize;
vec4 lookup(vec3 d) {
  float r = sqrt(max(0.0, 1.0 - abs(d.z)));
  float ax = abs(d.x);
  float ay = abs(d.y);
  float phi = (ax + ay > 0.0 ? atan(ay, ax) : 0.0) * 0.6366197723675814;
  float q = phi * r;
  float p = r - q;
  if (d.z < 0.0) { float t = p; p = 1.0 - q; q = 1.0 - t; }
  if (d.x < 0.0) p = -p;
  if (d.y < 0.0) q = -q;
  vec2 uv = vec2((p + 1.0) * 0.5, (1.0 - q) * 0.5);
  return texture2D(panoTexture, (uv * chartSize + 1.0) / (chartSize + 2.0));
}`,
  healpix: /* glsl */ `
uniform sampler2D panoTexture;
uniform vec2 chartSize;
uniform vec2 atlasSize;
vec4 lookup(vec3 d) {
  float a = atan(d.y, d.x);
  if (a < 0.0) a += 6.283185307179586;
  float t = a;
  float w = 1.1780972450961724 * d.z;
  if (abs(d.z) > 0.6666666666666666) {
    float sigma = sign(d.z) * (2.0 - sqrt(3.0 * (1.0 - abs(d.z))));
    t = a - (abs(sigma) - 1.0) * (mod(a, 1.5707963267948966) - 0.7853981633974483);
    w = 0.7853981633974483 * sigma;
  }
  float tu = mod(t / 0.7853981633974483, 8.0) - 4.0;
  float wu = w / 0.7853981633974483 + 5.0;
  float pp = clamp((wu + tu) * 0.5, 0.0, 5.0);
  float PP = min(4.0, floor(pp));
  float qq = clamp((wu - tu) * 0.5, 3.0 - PP, 6.0 - PP);
  float QQ = min(5.0 - PP, floor(qq));
  float face = 4.0 * (5.0 - (PP + QQ)) + mod(floor((PP - QQ + 4.0) * 0.5), 4.0);
  vec2 inFace = vec2(min(1.0, pp - PP), min(1.0, qq - QQ));
  vec2 cell = vec2(mod(face, 4.0), floor(face / 4.0));
  return texture2D(panoTexture, (cell * (chartSize + 2.0) + 1.0 + inFace * chartSize) / atlasSize);
}`,
};

const glslRayFragment = (kind: LookupKind) => /* glsl */ `
precision highp float;
varying vec3 vDir;
${GLSL_LOOKUP[kind]}
void main(void) {
  gl_FragColor = lookup(normalize(vDir));
}
`;

// ─── WGSL ──────────────────────────────────────────────────────────────

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
}
`;

const WGSL_PATCH_VERTEX = /* wgsl */ `
attribute position : vec3<f32>;
attribute uv : vec2<f32>;
uniform viewRotProj : mat4x4<f32>;
varying vUv : vec2<f32>;
@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  vertexOutputs.vUv = vertexInputs.uv;
  vertexOutputs.position = uniforms.viewRotProj * vec4<f32>(vertexInputs.position, 1.0);
}
`;

const WGSL_PATCH_FRAGMENT = /* wgsl */ `
var panoTexture : texture_2d<f32>;
var panoTextureSampler : sampler;
varying vUv : vec2<f32>;
@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  fragmentOutputs.color = textureSampleLevel(panoTexture, panoTextureSampler, fragmentInputs.vUv, 0.0);
}
`;

const WGSL_FLAT = /* wgsl */ `
var panoTexture : texture_2d<f32>;
var panoTextureSampler : sampler;
uniform chartSize : vec2<f32>;
uniform atlasSize : vec2<f32>;
`;
const WGSL_CUBE = /* wgsl */ `
var panoCube : texture_cube<f32>;
var panoCubeSampler : sampler;
`;

const WGSL_LOOKUP: Record<LookupKind, string> = {
  equirect: /* wgsl */ `${WGSL_FLAT}
fn lookup(d : vec3<f32>) -> vec4<f32> {
  let uv = vec2<f32>(atan2(d.x, d.y) / 6.283185307179586 + 0.5, 0.5 - asin(clamp(d.z, -1.0, 1.0)) / 3.141592653589793);
  return textureSampleLevel(panoTexture, panoTextureSampler, (uv * uniforms.chartSize + 1.0) / (uniforms.chartSize + 2.0), 0.0);
}`,
  cube: /* wgsl */ `${WGSL_CUBE}
fn lookup(d : vec3<f32>) -> vec4<f32> {
  return textureSampleLevel(panoCube, panoCubeSampler, vec3<f32>(d.x, d.z, d.y), 0.0);
}`,
  eac: /* wgsl */ `${WGSL_CUBE}
fn lookup(d : vec3<f32>) -> vec4<f32> {
  let g = vec3<f32>(d.x, d.z, d.y);
  let a = abs(g);
  return textureSampleLevel(panoCube, panoCubeSampler, atan(g / max(a.x, max(a.y, a.z))) * 1.2732395447351628, 0.0);
}`,
  "oct-ea": /* wgsl */ `${WGSL_FLAT}
fn lookup(d : vec3<f32>) -> vec4<f32> {
  let r = sqrt(max(0.0, 1.0 - abs(d.z)));
  let ax = abs(d.x);
  let ay = abs(d.y);
  let phi = select(0.0, atan2(ay, ax), ax + ay > 0.0) * 0.6366197723675814;
  var q = phi * r;
  var p = r - q;
  if (d.z < 0.0) { let t = p; p = 1.0 - q; q = 1.0 - t; }
  if (d.x < 0.0) { p = -p; }
  if (d.y < 0.0) { q = -q; }
  let uv = vec2<f32>((p + 1.0) * 0.5, (1.0 - q) * 0.5);
  return textureSampleLevel(panoTexture, panoTextureSampler, (uv * uniforms.chartSize + 1.0) / (uniforms.chartSize + 2.0), 0.0);
}`,
  healpix: /* wgsl */ `${WGSL_FLAT}
fn floorMod(x : f32, y : f32) -> f32 { return x - y * floor(x / y); }
fn lookup(d : vec3<f32>) -> vec4<f32> {
  var a = atan2(d.y, d.x);
  if (a < 0.0) { a = a + 6.283185307179586; }
  var t = a;
  var w = 1.1780972450961724 * d.z;
  if (abs(d.z) > 0.6666666666666666) {
    let sigma = sign(d.z) * (2.0 - sqrt(3.0 * (1.0 - abs(d.z))));
    t = a - (abs(sigma) - 1.0) * (floorMod(a, 1.5707963267948966) - 0.7853981633974483);
    w = 0.7853981633974483 * sigma;
  }
  let tu = floorMod(t / 0.7853981633974483, 8.0) - 4.0;
  let wu = w / 0.7853981633974483 + 5.0;
  let pp = clamp((wu + tu) * 0.5, 0.0, 5.0);
  let PP = min(4.0, floor(pp));
  let qq = clamp((wu - tu) * 0.5, 3.0 - PP, 6.0 - PP);
  let QQ = min(5.0 - PP, floor(qq));
  let face = 4.0 * (5.0 - (PP + QQ)) + floorMod(floor((PP - QQ + 4.0) * 0.5), 4.0);
  let inFace = vec2<f32>(min(1.0, pp - PP), min(1.0, qq - QQ));
  let cell = vec2<f32>(floorMod(face, 4.0), floor(face / 4.0));
  return textureSampleLevel(panoTexture, panoTextureSampler, (cell * (uniforms.chartSize + 2.0) + 1.0 + inFace * uniforms.chartSize) / uniforms.atlasSize, 0.0);
}`,
};

const wgslRayFragment = (kind: LookupKind) => /* wgsl */ `
varying vDir : vec3<f32>;
${WGSL_LOOKUP[kind]}
@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  fragmentOutputs.color = lookup(normalize(fragmentInputs.vDir));
}
`;

// ─── Sources by backend ────────────────────────────────────────────────

export interface ShaderSource { vertexSource: string; fragmentSource: string }

export function rayLookupShader(kind: LookupKind, webGpu: boolean): ShaderSource {
  return webGpu ? { vertexSource: WGSL_RAY_VERTEX, fragmentSource: wgslRayFragment(kind) } : { vertexSource: GLSL_RAY_VERTEX, fragmentSource: glslRayFragment(kind) };
}

export function patchShader(webGpu: boolean): ShaderSource {
  return webGpu ? { vertexSource: WGSL_PATCH_VERTEX, fragmentSource: WGSL_PATCH_FRAGMENT } : { vertexSource: GLSL_PATCH_VERTEX, fragmentSource: GLSL_PATCH_FRAGMENT };
}

/** A count of the costly things in a lookup, read off the GLSL source: a rough measure of shader complexity. */
export function lookupComplexity(kind: LookupKind | "patch") {
  const source = kind === "patch" ? GLSL_PATCH_FRAGMENT : GLSL_LOOKUP[kind];
  const count = (pattern: RegExp) => (source.match(pattern) ?? []).length;
  return {
    textureFetches: count(/texture2D\(|textureCube\(/g),
    inverseTrigonometric: count(/\batan\(|\basin\(/g),
    squareRoots: count(/\bsqrt\(/g),
    branches: count(/\bif \(|\?/g),
    sourceCharacters: source.replace(/\s+/g, " ").length,
  };
}
